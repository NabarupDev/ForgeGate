import {
  OutboundRateLimiter,
  extractProviderFromUrlOrConfig,
} from '../src/workflow-engine/outbound-rate-limiter';
import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import { calculateRetryDecision } from '../src/workflow-engine/http-retry-scheduler';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

/**
 * Lightweight mock Redis implementation matching ioredis operations used by OutboundRateLimiter
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
    this.store.set(key, Math.max(0, val));
    return val;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const expireAt = Date.now() + seconds * 1000;
    this.ttls.set(key, expireAt);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const expireAt = this.ttls.get(key);
    if (!expireAt) return -2;
    const remainingMs = expireAt - Date.now();
    if (remainingMs <= 0) {
      this.store.delete(key);
      this.ttls.delete(key);
      return -2;
    }
    return Math.ceil(remainingMs / 1000);
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  // Test helper to simulate passage of time
  advanceTime(seconds: number) {
    const now = Date.now() + seconds * 1000;
    for (const [key, expireAt] of this.ttls.entries()) {
      if (expireAt <= now) {
        this.store.delete(key);
        this.ttls.delete(key);
      }
    }
  }
}

describe('Outbound Rate Limiter Unit & Integration Tests', () => {
  let mockRedis: InMemoryMockRedis;
  let limiter: OutboundRateLimiter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = new InMemoryMockRedis();
    limiter = new OutboundRateLimiter(mockRedis as any);
  });

  describe('1. Provider Extraction Helper', () => {
    it('should extract provider explicitly configured in step config', () => {
      expect(extractProviderFromUrlOrConfig({ provider: 'OpenAI' })).toBe('openai');
    });

    it('should extract hostname as provider from target URL when provider is omitted', () => {
      expect(
        extractProviderFromUrlOrConfig({ url: 'https://api.stripe.com/v1/charges' }),
      ).toBe('api.stripe.com');
    });

    it('should fallback to generic when neither valid provider nor URL hostname is present', () => {
      expect(extractProviderFromUrlOrConfig({})).toBe('generic');
    });
  });

  describe('2. Multi-Scope Rate Limiting', () => {
    it('should enforce global outbound rate limit across all tenants & providers', async () => {
      limiter.setConfig({
        globalLimit: { limit: 2, windowSeconds: 60 },
      });

      // Request 1: Tenant A + Provider X -> Allowed
      const res1 = await limiter.checkAndConsume({
        tenantId: 'tenant-a',
        provider: 'provider-x',
      });
      expect(res1.allowed).toBe(true);

      // Request 2: Tenant B + Provider Y -> Allowed
      const res2 = await limiter.checkAndConsume({
        tenantId: 'tenant-b',
        provider: 'provider-y',
      });
      expect(res2.allowed).toBe(true);

      // Request 3: Exceeds global limit (2) -> Rejected
      const res3 = await limiter.checkAndConsume({
        tenantId: 'tenant-c',
        provider: 'provider-z',
      });
      expect(res3.allowed).toBe(false);
      expect(res3.exceededScope).toBe('global');
      expect(res3.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('should enforce per-provider outbound rate limit independently of other providers', async () => {
      limiter.setConfig({
        providerLimits: {
          openai: { limit: 2, windowSeconds: 60 },
          anthropic: { limit: 5, windowSeconds: 60 },
        },
      });

      // 2 Requests to openai -> Allowed
      await limiter.checkAndConsume({ tenantId: 'tenant-a', provider: 'openai' });
      await limiter.checkAndConsume({ tenantId: 'tenant-b', provider: 'openai' });

      // 3rd Request to openai -> Rejected
      const resOpenAi = await limiter.checkAndConsume({ tenantId: 'tenant-c', provider: 'openai' });
      expect(resOpenAi.allowed).toBe(false);
      expect(resOpenAi.exceededScope).toBe('provider');

      // Request to anthropic -> Allowed (provider isolation)
      const resAnthropic = await limiter.checkAndConsume({
        tenantId: 'tenant-a',
        provider: 'anthropic',
      });
      expect(resAnthropic.allowed).toBe(true);
    });

    it('should enforce per-tenant + provider outbound rate limit with tenant isolation', async () => {
      limiter.setConfig({
        tenantProviderLimits: {
          'tenant-a': { openai: { limit: 1, windowSeconds: 60 } },
          'tenant-b': { openai: { limit: 5, windowSeconds: 60 } },
        },
      });

      // Tenant A -> 1st request allowed
      const resA1 = await limiter.checkAndConsume({ tenantId: 'tenant-a', provider: 'openai' });
      expect(resA1.allowed).toBe(true);

      // Tenant A -> 2nd request rejected (exceeds tenant-a quota of 1)
      const resA2 = await limiter.checkAndConsume({ tenantId: 'tenant-a', provider: 'openai' });
      expect(resA2.allowed).toBe(false);
      expect(resA2.exceededScope).toBe('tenant_provider');

      // Tenant B -> request allowed (Tenant B has separate quota of 5)
      const resB1 = await limiter.checkAndConsume({ tenantId: 'tenant-b', provider: 'openai' });
      expect(resB1.allowed).toBe(true);
    });

    it('should enforce step-level outbound rate limit', async () => {
      limiter.setConfig({
        stepLimits: {
          'step-strict': { limit: 1, windowSeconds: 60 },
        },
      });

      const res1 = await limiter.checkAndConsume({
        tenantId: 'tenant-a',
        stepId: 'step-strict',
      });
      expect(res1.allowed).toBe(true);

      const res2 = await limiter.checkAndConsume({
        tenantId: 'tenant-a',
        stepId: 'step-strict',
      });
      expect(res2.allowed).toBe(false);
      expect(res2.exceededScope).toBe('step');
    });
  });

  describe('3. Concurrency & Limit Reset', () => {
    it('should handle concurrent worker requests atomically without race conditions', async () => {
      limiter.setConfig({
        globalLimit: { limit: 5, windowSeconds: 60 },
      });

      // Simulate 10 concurrent workers sending requests simultaneously
      const promises = Array.from({ length: 10 }, (_, i) =>
        limiter.checkAndConsume({ tenantId: `worker-tenant-${i}`, provider: 'api' }),
      );

      const results = await Promise.all(promises);

      const allowedCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(5);
      expect(rejectedCount).toBe(5);
    });

    it('should reset limits after TTL window expires', async () => {
      limiter.setConfig({
        globalLimit: { limit: 1, windowSeconds: 10 },
      });

      const res1 = await limiter.checkAndConsume({ tenantId: 'tenant-a' });
      expect(res1.allowed).toBe(true);

      const res2 = await limiter.checkAndConsume({ tenantId: 'tenant-a' });
      expect(res2.allowed).toBe(false);

      // Fast-forward time past TTL window (10 seconds)
      mockRedis.advanceTime(11);

      const res3 = await limiter.checkAndConsume({ tenantId: 'tenant-a' });
      expect(res3.allowed).toBe(true);
    });
  });

  describe('4. Engine Pre-Flight Check & Retry Integration', () => {
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

      engineService = new WorkflowEngineService(prismaMock, limiter);
    });

    it('should prevent external HTTP request when outbound rate limit is exceeded', async () => {
      limiter.setConfig({
        globalLimit: { limit: 1, windowSeconds: 60 },
      });

      // Consume the 1 allowed slot
      await limiter.checkAndConsume({ tenantId: 'tenant-1' });

      const mockWorkflowExecution = {
        id: 'exec-outbound-limit',
        tenantId: 'tenant-1',
        workflowId: 'wf-limit',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-limited',
              order: 1,
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.external.com/data' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-limit-1',
        executionId: 'exec-outbound-limit',
        stepId: 'step-limited',
        attempt: 1,
        status: 'RUNNING',
      });

      let thrownError: any;
      try {
        await engineService.executeExecution('exec-outbound-limit', 'tenant-1', 1);
      } catch (err) {
        thrownError = err;
      }

      // External HTTP request MUST NOT be sent
      expect(mockedAxios).not.toHaveBeenCalled();

      // Error must be categorized as RATE_LIMITED with retryAfterSeconds
      expect(thrownError).toBeDefined();
      expect(thrownError.category).toBe('RATE_LIMITED');
      expect(thrownError.isRetryable).toBe(true);
      expect(thrownError.retryAfterSeconds).toBeGreaterThan(0);

      // Evaluate retry decision via HttpRetryScheduler
      const retryDecision = calculateRetryDecision(thrownError, 1, 0, new Date());
      expect(retryDecision.shouldRetry).toBe(true);
      expect(retryDecision.isRateLimitDeferral).toBe(true);
      expect(retryDecision.delayMs).toBe(thrownError.retryAfterSeconds * 1000);
      expect(retryDecision.newNormalAttemptCount).toBe(1); // Budget preserved!
    });
  });
});
