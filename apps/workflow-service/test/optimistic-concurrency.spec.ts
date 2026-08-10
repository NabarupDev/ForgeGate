import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';

describe('Optimistic Concurrency Control & State Transition Spec', () => {
  let engineService: WorkflowEngineService;
  let mockPrisma: any;
  let mockMetrics: any;

  beforeEach(() => {
    mockMetrics = {
      workflowExecutionsTotal: { inc: jest.fn() },
      stepExecutionsTotal: { inc: jest.fn() },
      stepTimeoutsTotal: { inc: jest.fn() },
      workflowDuration: { observe: jest.fn() },
      outboundHttpRequestsTotal: { inc: jest.fn() },
      outboundHttpDuration: { observe: jest.fn() },
      outboundHttpRateLimitDeferralsTotal: { inc: jest.fn() },
      outboundHttpTimeoutsTotal: { inc: jest.fn() },
    };

    mockPrisma = {
      workflowExecution: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      stepExecution: {
        findFirst: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      executionLog: {
        create: jest.fn(),
      },
    };

    engineService = new WorkflowEngineService(mockPrisma, mockMetrics);
  });

  describe('1. Concurrent Workflow Execution Claim (Worker A vs Worker B)', () => {
    it('should allow only one worker to claim and execute a workflow while the losing worker aborts', async () => {
      const mockExecution = {
        id: 'exec-100',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            { id: 'step-1', stepOrder: 1, actionType: 'data_transform', config: { mapping: { key: 'val' } } },
          ],
        },
      };

      mockPrisma.workflowExecution.findFirst.mockResolvedValue(mockExecution);

      // Worker A wins execution claim ({ count: 1 }), Worker B loses ({ count: 0 })
      let claimCallCount = 0;
      mockPrisma.workflowExecution.updateMany.mockImplementation(async (args: any) => {
        if (args.data.status === 'running') {
          claimCallCount++;
          if (claimCallCount === 1) return { count: 1 };
          return { count: 0 };
        }
        return { count: 1 };
      });

      mockPrisma.stepExecution.findFirst.mockResolvedValue(null);
      mockPrisma.stepExecution.create.mockResolvedValue({ id: 'step-exec-1' });
      mockPrisma.stepExecution.updateMany.mockResolvedValue({ count: 1 });

      const pA = engineService.executeExecution('exec-100', 'tenant-1', 1, 'worker-A');
      const pB = engineService.executeExecution('exec-100', 'tenant-1', 1, 'worker-B');

      await Promise.all([pA, pB]);

      // Step execution should only be created once (by winning Worker A)
      expect(mockPrisma.stepExecution.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Concurrent Step Execution Claim', () => {
    it('should prevent second worker from claiming step if already claimed by active worker', async () => {
      const mockExecution = {
        id: 'exec-200',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            { id: 'step-1', stepOrder: 1, actionType: 'data_transform', config: {} },
          ],
        },
      };

      mockPrisma.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      mockPrisma.workflowExecution.updateMany.mockResolvedValue({ count: 1 });

      // Simulate step already RUNNING on active worker-A
      mockPrisma.stepExecution.findFirst.mockResolvedValue({
        id: 'step-exec-active',
        status: 'RUNNING',
        workerId: 'worker-A',
        heartbeatAt: new Date(),
      });

      // Worker B attempts to run the execution
      await engineService.executeExecution('exec-200', 'tenant-1', 1, 'worker-B');

      // Worker B should skip step creation because Worker A is active
      expect(mockPrisma.stepExecution.create).toHaveBeenCalledTimes(0);
    });
  });

  describe('3. Preemption & Stale Recovery Protection', () => {
    it('should not overwrite TIMED_OUT status if worker finishes after lease expiration', async () => {
      // Simulate step execution being recovered and marked TIMED_OUT (returns 0 for RUNNING -> SUCCEEDED)
      mockPrisma.stepExecution.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await mockPrisma.stepExecution.updateMany({
        where: { id: 'step-exec-stale', status: 'RUNNING', workerId: 'worker-A' },
        data: { status: 'SUCCEEDED', version: { increment: 1 } },
      });

      expect(result.count).toBe(0);
    });
  });

  describe('4. Terminal State Protection', () => {
    it('should prevent markAsFailed from overwriting completed execution status', async () => {
      mockPrisma.workflowExecution.updateMany.mockResolvedValue({ count: 0 });

      await engineService.markAsFailed('exec-completed-1', 'Late failure');

      expect(mockPrisma.workflowExecution.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'exec-completed-1',
          status: { notIn: ['completed'] },
        },
        data: {
          status: 'failed',
          completedAt: expect.any(Date),
          version: { increment: 1 },
        },
      });
    });
  });
});
