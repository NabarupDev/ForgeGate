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
    this.cleanExpired();
    const val = (this.store.get(key) || 0) + 1;
    this.store.set(key, val);
    return val;
  }

  async decr(key: string): Promise<number> {
    this.cleanExpired();
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

  advanceTime(seconds: number) {
    const now = Date.now() + seconds * 1000;
    for (const [key, expireAt] of this.ttls.entries()) {
      if (expireAt <= now) {
        this.store.delete(key);
        this.ttls.delete(key);
      }
    }
  }

  private cleanExpired() {
    const now = Date.now();
    for (const [key, expireAt] of this.ttls.entries()) {
      if (expireAt <= now) {
        this.store.delete(key);
        this.ttls.delete(key);
      }
    }
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

    it('should release lease on HTTP request timeout', async () => {
      concurrencyLimiter.setConfig({
        providerLimits: { 'api.timeout.com': 1 },
      });

      const mockWorkflowExecution = {
        id: 'exec-conc-timeout',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-conc-timeout',
              order: 1,
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.timeout.com/data' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-conc-timeout',
        executionId: 'exec-conc-timeout',
        stepId: 'step-conc-timeout',
        attempt: 1,
        status: 'RUNNING',
      });

      const timeoutError: any = new Error('timeout of 5000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      mockedAxios.mockRejectedValueOnce(timeoutError);

      try {
        await engineService.executeExecution('exec-conc-timeout', 'tenant-1', 1);
      } catch (err) {
        // Expected timeout failure
      }

      // Verify slot was released in finally block on timeout
      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.acquiredTotal).toBe(1);
      expect(metrics.releasedTotal).toBe(1);
    });
  });

  describe('4. Worker Crash Recovery & Multi-Worker Concurrency', () => {
    it('should recover leaked capacity after worker crash via Redis lease TTL expiration', async () => {
      const sharedRedis = new InMemoryMockRedis();
      const workerLimiter = new OutboundConcurrencyLimiter(sharedRedis as any, {
        providerLimits: { stripe: 1 },
      });

      // Worker 1 acquires slot but crashes before releasing
      const res1 = await workerLimiter.acquire({ tenantId: 'tenant-a', provider: 'stripe' });
      expect(res1.acquired).toBe(true);

      // Worker 2 attempts acquire immediately -> Rejected (Worker 1 holds capacity)
      const res2Immediate = await workerLimiter.acquire({ tenantId: 'tenant-b', provider: 'stripe' });
      expect(res2Immediate.acquired).toBe(false);

      // Fast-forward time past lease TTL (60s) to simulate worker crash cleanup
      sharedRedis.advanceTime(61);

      // Worker 2 retries -> Capacity recovered automatically!
      const res2AfterRecovery = await workerLimiter.acquire({ tenantId: 'tenant-b', provider: 'stripe' });
      expect(res2AfterRecovery.acquired).toBe(true);
    });

    it('should enforce multi-scope concurrency limits matching prompt requirements (Global=100, OpenAI=20, Stripe=10, Tenant A+OpenAI=5)', async () => {
      const sharedRedis = new InMemoryMockRedis();
      const limiterInstance = new OutboundConcurrencyLimiter(sharedRedis as any, {
        globalMaxConcurrency: 100,
        providerLimits: {
          openai: 20,
          stripe: 10,
        },
        tenantProviderLimits: {
          'tenant-a': { openai: 5 },
        },
      });

      // 1. Tenant A fills its tenant+provider quota (5 slots for openai)
      const tenantAOpenAiAcquires = await Promise.all(
        Array.from({ length: 5 }, () => limiterInstance.acquire({ tenantId: 'tenant-a', provider: 'openai' })),
      );
      expect(tenantAOpenAiAcquires.every((r) => r.acquired)).toBe(true);

      // 6th attempt by Tenant A for OpenAI -> Exceeds tenant-a + openai limit (5)
      const tenantA6th = await limiterInstance.acquire({ tenantId: 'tenant-a', provider: 'openai' });
      expect(tenantA6th.acquired).toBe(false);
      expect(tenantA6th.exceededScope).toBe('tenant_provider');

      // 2. Tenant B can still acquire OpenAI slots (leaving remaining 15 slots for provider openai)
      const tenantBOpenAiAcquires = await Promise.all(
        Array.from({ length: 5 }, () => limiterInstance.acquire({ tenantId: 'tenant-b', provider: 'openai' })),
      );
      expect(tenantBOpenAiAcquires.every((r) => r.acquired)).toBe(true);

      // 3. Tenant A can still acquire Stripe slots (Stripe limit = 10)
      const tenantAStripe = await limiterInstance.acquire({ tenantId: 'tenant-a', provider: 'stripe' });
      expect(tenantAStripe.acquired).toBe(true);
    });

    it('should coordinate concurrency limits across 3 distributed worker instances sharing Redis', async () => {
      const sharedRedis = new InMemoryMockRedis();

      const worker1 = new OutboundConcurrencyLimiter(sharedRedis as any, { providerLimits: { openai: 3 } });
      const worker2 = new OutboundConcurrencyLimiter(sharedRedis as any, { providerLimits: { openai: 3 } });
      const worker3 = new OutboundConcurrencyLimiter(sharedRedis as any, { providerLimits: { openai: 3 } });

      // Worker 1 acquires 1
      const resW1 = await worker1.acquire({ tenantId: 't1', provider: 'openai' });
      // Worker 2 acquires 1
      const resW2 = await worker2.acquire({ tenantId: 't2', provider: 'openai' });
      // Worker 3 acquires 1
      const resW3 = await worker3.acquire({ tenantId: 't3', provider: 'openai' });

      expect(resW1.acquired).toBe(true);
      expect(resW2.acquired).toBe(true);
      expect(resW3.acquired).toBe(true);

      // Worker 1 tries 4th slot -> Exceeds provider limit (3) across distributed workers!
      const resW1Overflow = await worker1.acquire({ tenantId: 't4', provider: 'openai' });
      expect(resW1Overflow.acquired).toBe(false);
      expect(resW1Overflow.exceededScope).toBe('provider');

      // Worker 2 releases lease
      await worker2.release(resW2.lease);

      // Worker 3 tries again -> Successfully acquires newly released slot!
      const resW3Retry = await worker3.acquire({ tenantId: 't4', provider: 'openai' });
      expect(resW3Retry.acquired).toBe(true);
    });
  });
});
