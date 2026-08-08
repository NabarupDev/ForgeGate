import { generateStepIdempotencyKey } from '../src/workflow-engine/idempotency';
import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('HTTP Step Idempotency & Duplicate Execution Protection Unit Tests', () => {
  describe('1. Idempotency Key Generation & Stability', () => {
    it('should generate stable idempotency key format forgegate:{tenantId}:{executionId}:{stepId}', () => {
      const key = generateStepIdempotencyKey('tenant-alpha', 'exec-100', 'step-pay');
      expect(key).toBe('forgegate:tenant-alpha:exec-100:step-pay');
    });

    it('should maintain key stability across retries of the same step execution', () => {
      const retry1Key = generateStepIdempotencyKey('tenant-alpha', 'exec-100', 'step-pay');
      const retry2Key = generateStepIdempotencyKey('tenant-alpha', 'exec-100', 'step-pay');

      expect(retry1Key).toBe(retry2Key);
    });

    it('should produce distinct keys for different workflow executions and different steps', () => {
      const keyExec1 = generateStepIdempotencyKey('tenant-alpha', 'exec-100', 'step-pay');
      const keyExec2 = generateStepIdempotencyKey('tenant-alpha', 'exec-101', 'step-pay');
      const keyStep2 = generateStepIdempotencyKey('tenant-alpha', 'exec-100', 'step-ship');

      expect(keyExec1).not.toBe(keyExec2);
      expect(keyExec1).not.toBe(keyStep2);
    });

    it('should enforce tenant isolation in key generation', () => {
      const keyTenantA = generateStepIdempotencyKey('tenant-A', 'exec-100', 'step-pay');
      const keyTenantB = generateStepIdempotencyKey('tenant-B', 'exec-100', 'step-pay');

      expect(keyTenantA).not.toBe(keyTenantB);
      expect(keyTenantA).toContain('tenant-A');
      expect(keyTenantB).toContain('tenant-B');
    });
  });

  describe('2. Downstream HTTP Idempotency Header Injection', () => {
    let engineService: WorkflowEngineService;
    let prismaMock: any;

    beforeEach(() => {
      jest.clearAllMocks();

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

      engineService = new WorkflowEngineService(prismaMock);
    });

    it('should inject Idempotency-Key header when downstream idempotency is enabled', async () => {
      const mockWorkflowExecution = {
        id: 'exec-idem-1',
        tenantId: 'tenant-stripe',
        workflowId: 'wf-stripe',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-charge',
              order: 1,
              actionType: 'http_request',
              config: {
                url: 'https://api.stripe.com/v1/charges',
                method: 'POST',
                idempotency: {
                  enabled: true,
                },
              },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-charge-1',
        executionId: 'exec-idem-1',
        stepId: 'step-charge',
        attempt: 1,
        status: 'RUNNING',
      });

      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { id: 'ch_12345', status: 'succeeded' },
      } as any);

      await engineService.executeExecution('exec-idem-1', 'tenant-stripe', 1);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.stripe.com/v1/charges',
          headers: expect.objectContaining({
            'Idempotency-Key': 'forgegate:tenant-stripe:exec-idem-1:step-charge',
          }),
        }),
      );
    });

    it('should support custom idempotency header name (e.g. X-Idempotency-Key)', async () => {
      const mockWorkflowExecution = {
        id: 'exec-idem-custom',
        tenantId: 'tenant-custom',
        workflowId: 'wf-custom',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-custom-charge',
              order: 1,
              actionType: 'http_request',
              config: {
                url: 'https://api.provider.com/charge',
                method: 'POST',
                idempotency: {
                  enabled: true,
                  headerName: 'X-Idempotency-Key',
                },
              },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-custom-1',
        executionId: 'exec-idem-custom',
        stepId: 'step-custom-charge',
        attempt: 1,
        status: 'RUNNING',
      });

      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { success: true },
      } as any);

      await engineService.executeExecution('exec-idem-custom', 'tenant-custom', 1);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Idempotency-Key': 'forgegate:tenant-custom:exec-idem-custom:step-custom-charge',
          }),
        }),
      );
    });

    it('should NOT inject Idempotency-Key header when idempotency is disabled or omitted', async () => {
      const mockWorkflowExecution = {
        id: 'exec-no-idem',
        tenantId: 'tenant-generic',
        workflowId: 'wf-generic',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-webhook',
              order: 1,
              actionType: 'http_request',
              config: {
                url: 'https://api.generic.com/webhook',
                method: 'POST',
              },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-web-1',
        executionId: 'exec-no-idem',
        stepId: 'step-webhook',
        attempt: 1,
        status: 'RUNNING',
      });

      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { ok: true },
      } as any);

      await engineService.executeExecution('exec-no-idem', 'tenant-generic', 1);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.not.objectContaining({
            'Idempotency-Key': expect.any(String),
          }),
        }),
      );
    });
  });

  describe('3. Durable State Check (Skip Duplicate Execution & Handle Retries)', () => {
    let engineService: WorkflowEngineService;
    let prismaMock: any;

    beforeEach(() => {
      jest.clearAllMocks();

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

      engineService = new WorkflowEngineService(prismaMock);
    });

    it('should skip HTTP execution and return cached output when previous attempt SUCCEEDED', async () => {
      const mockWorkflowExecution = {
        id: 'exec-already-done',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-prev-succeeded',
              order: 1,
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.example.com/charge' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);

      // Simulate a previously completed attempt in StepExecution table
      prismaMock.stepExecution.findFirst.mockResolvedValue({
        id: 'se-prev-1',
        executionId: 'exec-already-done',
        stepId: 'step-prev-succeeded',
        status: 'SUCCEEDED',
        output: { statusCode: 200, data: { chargeId: 'ch_cached_99' } },
      });

      const result = await engineService.executeExecution('exec-already-done', 'tenant-1', 2);

      // Verify HTTP request was NOT executed again
      expect(mockedAxios).not.toHaveBeenCalled();

      // Verify result returns payload with cached output
      expect(result).toEqual(
        expect.objectContaining({
          status: 'completed',
        }),
      );

      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'exec-already-done' },
          data: expect.objectContaining({
            status: 'completed',
            metadata: expect.objectContaining({
              step_1: { statusCode: 200, data: { chargeId: 'ch_cached_99' } },
            }),
          }),
        }),
      );
    });

    it('should re-execute HTTP request using same idempotency key when previous attempt FAILED or TIMED_OUT', async () => {
      const mockWorkflowExecution = {
        id: 'exec-retry-failed',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-prev-failed',
              order: 1,
              actionType: 'http_request',
              config: {
                url: 'https://api.example.com/charge',
                idempotency: { enabled: true },
              },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);

      // Previous attempt was FAILED (findFirst for SUCCEEDED returns null)
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-attempt-2',
        executionId: 'exec-retry-failed',
        stepId: 'step-prev-failed',
        attempt: 2,
        status: 'RUNNING',
      });

      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { chargeId: 'ch_retry_ok' },
      } as any);

      await engineService.executeExecution('exec-retry-failed', 'tenant-1', 2);

      // Verify HTTP request was made with stable idempotency key
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'Idempotency-Key': 'forgegate:tenant-1:exec-retry-failed:step-prev-failed',
          }),
        }),
      );
    });

    it('should prevent duplicate concurrent execution when atomic claim (PENDING -> RUNNING) fails', async () => {
      const mockWorkflowExecution = {
        id: 'exec-concurrent',
        tenantId: 'tenant-1',
        workflowId: 'wf-1',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-concurrent',
              order: 1,
              actionType: 'http_request',
              config: { url: 'https://api.example.com/pay' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-conc-1',
        executionId: 'exec-concurrent',
        stepId: 'step-concurrent',
        attempt: 1,
        status: 'PENDING',
      });

      // Simulate atomic claim failure (count: 0) because another worker claimed it
      prismaMock.stepExecution.updateMany.mockResolvedValue({ count: 0 });

      await engineService.executeExecution('exec-concurrent', 'tenant-1', 1);

      // HTTP step must NOT execute
      expect(mockedAxios).not.toHaveBeenCalled();
    });
  });
});
