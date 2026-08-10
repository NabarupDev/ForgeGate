import { QueueService } from '../src/queue/queue.service';
import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import { NotificationWorker } from '../../notification-service/src/notification.worker';
import { RedisService } from '../../auth-service/src/redis.service';
import { RedisRateLimiterGuard } from '../../api-gateway/src/rate-limiter/rate-limiter.guard';

describe('Production-Grade Graceful Shutdown Spec', () => {
  describe('1. QueueService Graceful Teardown', () => {
    it('should cleanly pause worker polling, stop recovery timer, and close BullMQ queues on onModuleDestroy', async () => {
      const mockWorker = {
        pause: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      };
      const mockDlqWorker = {
        close: jest.fn().mockResolvedValue(undefined),
      };
      const mockQueue = {
        close: jest.fn().mockResolvedValue(undefined),
      };
      const mockQueueEvents = {
        close: jest.fn().mockResolvedValue(undefined),
      };

      const engineServiceMock: any = {};
      const queueService = new QueueService(engineServiceMock);

      (queueService as any).worker = mockWorker;
      (queueService as any).dlqWorker = mockDlqWorker;
      (queueService as any).workflowQueue = mockQueue;
      (queueService as any).dlqQueue = mockQueue;
      (queueService as any).queueEvents = mockQueueEvents;
      (queueService as any).recoveryTimer = setInterval(() => {}, 10000);

      await expect(queueService.onModuleDestroy()).resolves.not.toThrow();

      expect(mockWorker.pause).toHaveBeenCalledWith(true);
      expect(mockWorker.close).toHaveBeenCalled();
      expect(mockDlqWorker.close).toHaveBeenCalled();
      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockQueueEvents.close).toHaveBeenCalled();
      expect((queueService as any).recoveryTimer).toBeNull();
    });
  });

  describe('2. WorkflowEngineService & Outbound Limiters Teardown', () => {
    it('should disconnect outbound rate limiter and concurrency limiter connections on shutdown', async () => {
      const mockRateLimiter = {
        disconnect: jest.fn().mockResolvedValue(undefined),
      };
      const mockConcurrencyLimiter = {
        disconnect: jest.fn().mockResolvedValue(undefined),
      };

      const engineService = new WorkflowEngineService(
        {} as any,
        mockRateLimiter as any,
        mockConcurrencyLimiter as any,
      );

      await expect(engineService.onModuleDestroy()).resolves.not.toThrow();

      expect(mockRateLimiter.disconnect).toHaveBeenCalled();
      expect(mockConcurrencyLimiter.disconnect).toHaveBeenCalled();
    });
  });

  describe('3. Microservice Redis Teardown Hooks', () => {
    it('should close Redis connection in RedisService on module destroy', async () => {
      const redisService = new RedisService();
      const mockClient = {
        quit: jest.fn().mockResolvedValue('OK'),
        disconnect: jest.fn(),
      };
      (redisService as any).client = mockClient;

      await expect(redisService.onModuleDestroy()).resolves.not.toThrow();
      expect(mockClient.quit).toHaveBeenCalled();
    });

    it('should close Redis connection in RedisRateLimiterGuard on module destroy', async () => {
      const guard = new RedisRateLimiterGuard();
      const mockRedis = {
        quit: jest.fn().mockResolvedValue('OK'),
        disconnect: jest.fn(),
      };
      (guard as any).redis = mockRedis;

      await expect(guard.onModuleDestroy()).resolves.not.toThrow();
      expect(mockRedis.quit).toHaveBeenCalled();
    });

    it('should pause and close BullMQ worker in NotificationWorker on module destroy', async () => {
      const worker = new NotificationWorker();
      const mockWorker = {
        pause: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      };
      (worker as any).worker = mockWorker;

      await expect(worker.onModuleDestroy()).resolves.not.toThrow();
      expect(mockWorker.pause).toHaveBeenCalledWith(true);
      expect(mockWorker.close).toHaveBeenCalled();
    });
  });

  describe('4. Workflow Worker Interrupted Work Recovery Safety', () => {
    it('should NOT mark in-flight work as successful when shutdown starts, preserving StepExecution state for heartbeat recovery', async () => {
      // Create a mock execution state representing a step that was RUNNING when shutdown initiated
      const mockPrisma: any = {
        stepExecution: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'se-interrupted-1',
              executionId: 'exec-interrupted-99',
              stepId: 'http-step-payment',
              status: 'RUNNING',
              startedAt: new Date(Date.now() - 40000), // Started 40s ago (stale > 30s)
              heartbeatAt: new Date(Date.now() - 40000),
              execution: { id: 'exec-interrupted-99', tenantId: 'tenant-resilient' },
            },
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const engineService = new WorkflowEngineService(mockPrisma);
      const queueService = new QueueService(engineService);

      // Simulate a new worker node coming online after shutdown and recovering the stale RUNNING step
      (queueService as any).workflowQueue = {
        getJobs: jest.fn().mockResolvedValue([]),
        add: jest.fn().mockResolvedValue({ id: 'recovered-job-1' }),
      };

      const recoveryResult = await queueService.recoverStaleExecutions(30000);

      expect(recoveryResult.staleCount).toBe(1);
      expect(recoveryResult.reenqueuedCount).toBe(1);
      expect(recoveryResult.reenqueuedIds).toContain('exec-interrupted-99');
    });
  });
});
