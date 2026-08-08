import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('WorkflowEngineService (Current Behavior & StepExecution Lifecycle Tests)', () => {
  let service: WorkflowEngineService;
  let prismaMock: any;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaMock = {
      workflowExecution: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      executionLog: {
        create: jest.fn(),
      },
      stepExecution: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'step-exec-uuid-1' }),
        update: jest.fn().mockResolvedValue({ id: 'step-exec-uuid-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    service = new WorkflowEngineService(prismaMock as any);
  });

  describe('executeExecution & Tenant Isolation', () => {
    it('should throw tenant isolation error if workflow execution does not match executionId and tenantId', async () => {
      prismaMock.workflowExecution.findFirst.mockResolvedValue(null);

      await expect(
        service.executeExecution('exec-123', 'tenant-wrong', 1),
      ).rejects.toThrow('Workflow execution exec-123 not found for tenant tenant-wrong');
    });

    it('should set status to retrying on attemptCount > 1', async () => {
      const mockExecution = {
        id: 'exec-1',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        currentStep: 1,
        metadata: {},
        workflow: { steps: [] },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});

      await service.executeExecution('exec-1', 'tenant-1', 2);

      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec-1' },
        data: { status: 'retrying' },
      });
    });
  });

  describe('StepExecution Lifecycle Transitions (PENDING -> RUNNING -> SUCCEEDED / FAILED / TIMED_OUT)', () => {
    it('should transition StepExecution PENDING -> RUNNING -> SUCCEEDED on successful step', async () => {
      const mockExecution = {
        id: 'exec-success-step',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        status: 'pending',
        currentStep: 1,
        metadata: { key: 'val' },
        workflow: {
          steps: [
            {
              id: 'step-100',
              stepOrder: 1,
              actionType: 'data_transform',
              config: { mapping: { test: 'value' } },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      const result = await service.executeExecution('exec-success-step', 'tenant-1', 1);

      expect(result.status).toBe('completed');

      // 1. Creation in PENDING
      expect(prismaMock.stepExecution.create).toHaveBeenCalledWith({
        data: {
          executionId: 'exec-success-step',
          stepId: 'step-100',
          attempt: 1,
          status: 'PENDING',
          input: { key: 'val' },
          workerId: expect.any(String),
        },
      });

      // 2. Transition to RUNNING via atomic updateMany
      expect(prismaMock.stepExecution.updateMany).toHaveBeenCalledWith({
        where: { id: 'step-exec-uuid-1', status: 'PENDING' },
        data: {
          status: 'RUNNING',
          workerId: expect.any(String),
          startedAt: expect.any(Date),
          heartbeatAt: expect.any(Date),
        },
      });

      // 3. Transition to SUCCEEDED
      expect(prismaMock.stepExecution.update).toHaveBeenCalledWith({
        where: { id: 'step-exec-uuid-1' },
        data: {
          status: 'SUCCEEDED',
          finishedAt: expect.any(Date),
          output: { transformed: true, output: { test: 'value' } },
        },
      });
    });

    it('should transition StepExecution PENDING -> RUNNING -> FAILED on step error', async () => {
      const mockExecution = {
        id: 'exec-fail-step',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        status: 'pending',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            {
              id: 'step-fail',
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://invalid.endpoint/api', method: 'GET' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      mockedAxios.mockRejectedValue(new Error('Network error'));

      await expect(service.executeExecution('exec-fail-step', 'tenant-1', 1)).rejects.toThrow(
        'HTTP GET to https://invalid.endpoint/api failed: Network error',
      );

      // Transition to FAILED with structured HttpStepError details in output
      expect(prismaMock.stepExecution.update).toHaveBeenCalledWith({
        where: { id: 'step-exec-uuid-1' },
        data: {
          status: 'FAILED',
          finishedAt: expect.any(Date),
          error: 'HTTP GET to https://invalid.endpoint/api failed: Network error',
          output: expect.objectContaining({
            category: 'TRANSIENT_FAILURE',
            isRetryable: true,
          }),
        },
      });
    });

    it('should transition StepExecution PENDING -> RUNNING -> TIMED_OUT on timeout error', async () => {
      const mockExecution = {
        id: 'exec-timeout-step',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        status: 'pending',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            {
              id: 'step-timeout',
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://slow.endpoint/api', method: 'GET' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      const timeoutError: any = new Error('timeout of 5000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      mockedAxios.mockRejectedValue(timeoutError);

      await expect(service.executeExecution('exec-timeout-step', 'tenant-1', 1)).rejects.toThrow();

      // Transition to TIMED_OUT with structured HttpStepError details in output
      expect(prismaMock.stepExecution.update).toHaveBeenCalledWith({
        where: { id: 'step-exec-uuid-1' },
        data: {
          status: 'TIMED_OUT',
          finishedAt: expect.any(Date),
          error: 'HTTP GET to https://slow.endpoint/api failed: timeout of 5000ms exceeded',
          output: expect.objectContaining({
            category: 'TIMEOUT',
            isRetryable: true,
          }),
        },
      });
    });

    it('should redact sensitive keys in input payload for StepExecution', async () => {
      const mockExecution = {
        id: 'exec-secret',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        currentStep: 1,
        metadata: {
          authorization: 'Bearer super-secret-jwt',
          password: 'mySecretPassword',
          normalField: 'publicData',
        },
        workflow: {
          steps: [
            {
              id: 'step-secret',
              stepOrder: 1,
              actionType: 'data_transform',
              config: { mapping: { val: 'ok' } },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      await service.executeExecution('exec-secret', 'tenant-1', 1);

      expect(prismaMock.stepExecution.create).toHaveBeenCalledWith({
        data: {
          executionId: 'exec-secret',
          stepId: 'step-secret',
          attempt: 1,
          status: 'PENDING',
          input: {
            authorization: '[REDACTED]',
            password: '[REDACTED]',
            normalField: 'publicData',
          },
          workerId: expect.any(String),
        },
      });
    });
  });

  describe('markAsFailed', () => {
    it('should update workflow execution status to failed and create dead letter log entry', async () => {
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      await service.markAsFailed('exec-dlq-1', 'Max retries reached');

      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec-dlq-1' },
        data: {
          status: 'failed',
          completedAt: expect.any(Date),
        },
      });

      expect(prismaMock.executionLog.create).toHaveBeenCalledWith({
        data: {
          executionId: 'exec-dlq-1',
          status: 'failed_dead_letter',
          error: 'Max retries reached',
        },
      });
    });
  });
});
