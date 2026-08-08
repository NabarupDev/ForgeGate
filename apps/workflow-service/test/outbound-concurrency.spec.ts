import { OutboundConcurrencyLimiter } from '../src/workflow-engine/outbound-concurrency-limiter';
import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

/**
 * Lightweight mock Redis implementation for OutboundConcurrencyLimiter
 */
class InMemoryMockRedis {
  private store: Map<string, number> = new Map();
  private ttls: Map<string, number> = new Map();

  async incr(key: string): Promise<number> {
    const val = (this.store.get(key) || 0) + 1;
    this.store.set(key, val);
    return val;
  }

  async decr(key: string): Promise<number> {
    const val = (this.store.get(key) || 0) - 1;
    const newVal = Math.max(0, val);
    this.store.set(key, newVal);
    return newVal;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, parseInt(value, 10) || 0);
    return 'OK';
  }

  async expire(key: string, seconds: number): Promise<number> {
    const expireAt = Date.now() + seconds * 1000;
    this.ttls.set(key, expireAt);
    return 1;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

describe('Outbound Concurrency Control Unit & Integration Tests', () => {
  let mockRedis: InMemoryMockRedis;
  let concurrencyLimiter: OutboundConcurrencyLimiter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = new InMemoryMockRedis();
    concurrencyLimiter = new OutboundConcurrencyLimiter(mockRedis as any);
  });

  describe('1. Tenant & Provider Concurrency Limits', () => {
    it('should prevent one tenant from consuming all provider capacity (tenant capping)', async () => {
      concurrencyLimiter.setConfig({
        providerLimits: { openai: 4 },
        tenantLimits: { 'tenant-heavy': 2 },
      });

      // Tenant Heavy acquires 2 slots (hits tenant limit)
      const resA1 = await concurrencyLimiter.acquire({ tenantId: 'tenant-heavy', provider: 'openai' });
      const resA2 = await concurrencyLimiter.acquire({ tenantId: 'tenant-heavy', provider: 'openai' });

      expect(resA1.acquired).toBe(true);
      expect(resA2.acquired).toBe(true);

      // Tenant Heavy 3rd attempt -> Rejected due to tenant limit
      const resA3 = await concurrencyLimiter.acquire({ tenantId: 'tenant-heavy', provider: 'openai' });
      expect(resA3.acquired).toBe(false);
      expect(resA3.exceededScope).toBe('tenant');

      // Tenant Light can still acquire slots for openai (Fair sharing!)
      const resB1 = await concurrencyLimiter.acquire({ tenantId: 'tenant-light', provider: 'openai' });
      expect(resB1.acquired).toBe(true);
    });

    it('should fairly share provider capacity across multiple tenants up to provider limit', async () => {
      concurrencyLimiter.setConfig({
        providerLimits: { openai: 3 },
      });

      // Tenant A, Tenant B, Tenant C acquire 1 slot each
      const resA = await concurrencyLimiter.acquire({ tenantId: 'tenant-a', provider: 'openai' });
      const resB = await concurrencyLimiter.acquire({ tenantId: 'tenant-b', provider: 'openai' });
      const resC = await concurrencyLimiter.acquire({ tenantId: 'tenant-c', provider: 'openai' });

      expect(resA.acquired).toBe(true);
      expect(resB.acquired).toBe(true);
      expect(resC.acquired).toBe(true);

      // Tenant D 4th attempt -> Exceeds provider capacity limit (3)
      const resD = await concurrencyLimiter.acquire({ tenantId: 'tenant-d', provider: 'openai' });
      expect(resD.acquired).toBe(false);
      expect(resD.exceededScope).toBe('provider');
    });

    it('should respect tenant+provider specific concurrency limits', async () => {
      concurrencyLimiter.setConfig({
        tenantProviderLimits: {
          'tenant-a': { openai: 1 },
        },
      });

      const res1 = await concurrencyLimiter.acquire({ tenantId: 'tenant-a', provider: 'openai' });
      expect(res1.acquired).toBe(true);

      const res2 = await concurrencyLimiter.acquire({ tenantId: 'tenant-a', provider: 'openai' });
      expect(res2.acquired).toBe(false);
      expect(res2.exceededScope).toBe('tenant_provider');
    });

    it('should enforce global outbound concurrency limit across all workers', async () => {
      concurrencyLimiter.setConfig({
        globalMaxConcurrency: 2,
      });

      const res1 = await concurrencyLimiter.acquire({ tenantId: 'tenant-a' });
      const res2 = await concurrencyLimiter.acquire({ tenantId: 'tenant-b' });
      const res3 = await concurrencyLimiter.acquire({ tenantId: 'tenant-c' });

      expect(res1.acquired).toBe(true);
      expect(res2.acquired).toBe(true);

      expect(res3.acquired).toBe(false);
      expect(res3.exceededScope).toBe('global');
    });
  });

  describe('2. Lease Release & Deferred Execution Recovery', () => {
    it('should release concurrency slot after request completes and allow deferred requests', async () => {
      concurrencyLimiter.setConfig({
        providerLimits: { anthropic: 1 },
      });

      // Tenant A acquires slot
      const resA = await concurrencyLimiter.acquire({ tenantId: 'tenant-a', provider: 'anthropic' });
      expect(resA.acquired).toBe(true);

      // Tenant B attempt rejected while slot is held
      const resB1 = await concurrencyLimiter.acquire({ tenantId: 'tenant-b', provider: 'anthropic' });
      expect(resB1.acquired).toBe(false);

      // Tenant A finishes HTTP request and releases lease
      await concurrencyLimiter.release(resA.lease);

      // Tenant B retries -> Successfully acquires freed slot!
      const resB2 = await concurrencyLimiter.acquire({ tenantId: 'tenant-b', provider: 'anthropic' });
      expect(resB2.acquired).toBe(true);
    });

    it('should accurately track metrics for acquired, rejected, deferred, and released slots', async () => {
      concurrencyLimiter.setConfig({
        globalMaxConcurrency: 1,
      });

      const res1 = await concurrencyLimiter.acquire({ tenantId: 't1' });
      await concurrencyLimiter.acquire({ tenantId: 't2' }); // Rejected
      await concurrencyLimiter.release(res1.lease);

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.acquiredTotal).toBe(1);
      expect(metrics.rejectedTotal).toBe(1);
      expect(metrics.deferredTotal).toBe(1);
      expect(metrics.releasedTotal).toBe(1);
    });
  });

  describe('3. Engine Integration with Outbound Concurrency', () => {
    let engineService: WorkflowEngineService;
    let prismaMock: any;

    beforeEach(() => {
      prismaMock = {
        workflowExecution: {
          findFirst: jest.fn(),
          update: jest.fn(),
        },
        stepExecution: {
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        executionLog: {
          create: jest.fn(),
        },
      };

      engineService = new WorkflowEngineService(prismaMock, undefined, concurrencyLimiter);
    });

    it('should acquire lease before HTTP request and release lease in finally block on success', async () => {
      concurrencyLimiter.setConfig({
        providerLimits: { 'api.example.com': 2 },
      });

      const mockWorkflowExecution = {
        id: 'exec-conc-success',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-conc-1',
              order: 1,
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.example.com/data' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-conc-1',
        executionId: 'exec-conc-success',
        stepId: 'step-conc-1',
        attempt: 1,
        status: 'RUNNING',
      });

      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { success: true },
      } as any);

      await engineService.executeExecution('exec-conc-success', 'tenant-1', 1);

      expect(mockedAxios).toHaveBeenCalled();

      // Verify slot was acquired and subsequently released
      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.acquiredTotal).toBe(1);
      expect(metrics.releasedTotal).toBe(1);
    });

    it('should release lease even if HTTP request throws an exception', async () => {
      concurrencyLimiter.setConfig({
        providerLimits: { 'api.fail.com': 1 },
      });

      const mockWorkflowExecution = {
        id: 'exec-conc-fail',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-conc-fail',
              order: 1,
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.fail.com/data' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-conc-fail',
        executionId: 'exec-conc-fail',
        stepId: 'step-conc-fail',
        attempt: 1,
        status: 'RUNNING',
      });

      mockedAxios.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await engineService.executeExecution('exec-conc-fail', 'tenant-1', 1);
      } catch (err) {
        // Expected failure
      }

      // Verify slot was still safely released in finally block
      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.acquiredTotal).toBe(1);
      expect(metrics.releasedTotal).toBe(1);
    });
  });
});
