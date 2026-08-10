import { ApiIdempotencyService } from '../src/execution/api-idempotency.service';
import { ExecutionService } from '../src/execution/execution.service';
import { generateStepIdempotencyKey } from '../src/workflow-engine/idempotency';

describe('Public Mutation API & Outbound Step Idempotency Protection Unit & Concurrency Tests', () => {
  describe('1. ApiIdempotencyService Unit Tests', () => {
    let idempotencyService: ApiIdempotencyService;

    beforeEach(() => {
      idempotencyService = new ApiIdempotencyService();
    });

    it('should execute operation directly when idempotencyKey is omitted or empty', async () => {
      const handler = jest.fn().mockResolvedValue({ id: 'res-1' });

      const res1 = await idempotencyService.processIdempotentOperation('tenant-1', 'create', null, handler);
      const res2 = await idempotencyService.processIdempotentOperation('tenant-1', 'create', '', handler);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(res1).toEqual({ id: 'res-1' });
      expect(res2).toEqual({ id: 'res-1' });
    });

    it('should return cached result on duplicate request with same key without calling operation twice', async () => {
      let callCount = 0;
      const handler = jest.fn().mockImplementation(async () => {
        callCount++;
        return { executionId: `exec-${callCount}` };
      });

      const res1 = await idempotencyService.processIdempotentOperation('tenant-1', 'trigger:wf-1', 'idem-key-1', handler);
      const res2 = await idempotencyService.processIdempotentOperation('tenant-1', 'trigger:wf-1', 'idem-key-1', handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(res1).toEqual({ executionId: 'exec-1' });
      expect(res2).toEqual({ executionId: 'exec-1' }); // Reused cached result!
    });

    it('should execute new operation when different idempotency keys are used', async () => {
      let callCount = 0;
      const handler = jest.fn().mockImplementation(async () => {
        callCount++;
        return { executionId: `exec-${callCount}` };
      });

      const res1 = await idempotencyService.processIdempotentOperation('tenant-1', 'trigger:wf-1', 'key-A', handler);
      const res2 = await idempotencyService.processIdempotentOperation('tenant-1', 'trigger:wf-1', 'key-B', handler);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(res1).toEqual({ executionId: 'exec-1' });
      expect(res2).toEqual({ executionId: 'exec-2' });
    });

    it('should isolate idempotency keys by tenantId', async () => {
      let callCount = 0;
      const handler = jest.fn().mockImplementation(async () => {
        callCount++;
        return { executionId: `exec-${callCount}` };
      });

      const resA = await idempotencyService.processIdempotentOperation('tenant-A', 'trigger:wf-1', 'shared-key', handler);
      const resB = await idempotencyService.processIdempotentOperation('tenant-B', 'trigger:wf-1', 'shared-key', handler);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(resA).toEqual({ executionId: 'exec-1' });
      expect(resB).toEqual({ executionId: 'exec-2' });
    });

    it('should handle 10 concurrent duplicate requests safely and resolve all to single execution result', async () => {
      let createCounter = 0;
      const handler = jest.fn().mockImplementation(async () => {
        // Simulate database latency
        await new Promise((resolve) => setTimeout(resolve, 50));
        createCounter++;
        return { executionId: `exec-concurrent-${createCounter}` };
      });

      // Fire 10 concurrent requests simultaneously
      const concurrentPromises = Array.from({ length: 10 }).map(() =>
        idempotencyService.processIdempotentOperation('tenant-conc', 'trigger:wf-conc', 'concurrent-key-999', handler),
      );

      const results = await Promise.all(concurrentPromises);

      // Verify operation was called ONLY ONCE
      expect(handler).toHaveBeenCalledTimes(1);
      expect(createCounter).toBe(1);

      // Verify all 10 requests returned exact same executionId
      results.forEach((res) => {
        expect(res).toEqual({ executionId: 'exec-concurrent-1' });
      });
    });
  });

  describe('2. ExecutionService Integration with Idempotency Protection', () => {
    let executionService: ExecutionService;
    let idempotencyService: ApiIdempotencyService;
    let prismaMock: any;
    let queueMock: any;

    beforeEach(() => {
      prismaMock = {
        workflow: {
          findFirst: jest.fn().mockResolvedValue({ id: 'wf-100', tenantId: 't-1' }),
        },
        workflowExecution: {
          create: jest.fn().mockImplementation((data) => ({
            id: `exec-${Math.random().toString(36).substring(2, 7)}`,
            status: 'pending',
            ...data.data,
          })),
        },
      };

      queueMock = {
        addExecutionJob: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
      };

      idempotencyService = new ApiIdempotencyService();
      executionService = new ExecutionService(prismaMock, queueMock, idempotencyService);
    });

    it('should reuse execution result on duplicate workflow trigger calls with same Idempotency-Key', async () => {
      const dto = { tenantId: 't-1' };
      const user = { userId: 'u-1', tenantId: 't-1', role: 'admin' } as any;

      const res1 = await executionService.triggerWorkflow('wf-100', dto, user, 'idem-trigger-1');
      const res2 = await executionService.triggerWorkflow('wf-100', dto, user, 'idem-trigger-1');

      expect(prismaMock.workflowExecution.create).toHaveBeenCalledTimes(1);
      expect(res1.executionId).toBeDefined();
      expect(res2.executionId).toBe(res1.executionId);
    });
  });

  describe('3. Outbound Workflow Step Idempotency Key Generation', () => {
    it('should generate stable tenant-isolated idempotency key for outbound HTTP steps', () => {
      const key1 = generateStepIdempotencyKey('tenant-stripe', 'exec-888', 'step-charge');
      const key2 = generateStepIdempotencyKey('tenant-stripe', 'exec-888', 'step-charge');

      expect(key1).toBe('forgegate:tenant-stripe:exec-888:step-charge');
      expect(key2).toBe(key1);
    });
  });
});
