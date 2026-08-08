import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('WorkflowEngineService (Current Behavior Regression Tests)', () => {
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
    };

    service = new WorkflowEngineService(prismaMock as any);
  });

  describe('executeExecution & Tenant Isolation', () => {
    it('should throw tenant isolation error if workflow execution does not match executionId and tenantId', async () => {
      prismaMock.workflowExecution.findFirst.mockResolvedValue(null);

      await expect(
        service.executeExecution('exec-123', 'tenant-wrong', 1),
      ).rejects.toThrow('Workflow execution exec-123 not found for tenant tenant-wrong');

      expect(prismaMock.workflowExecution.findFirst).toHaveBeenCalledWith({
        where: { id: 'exec-123', tenantId: 'tenant-wrong' },
        include: {
          workflow: {
            include: {
              steps: {
                orderBy: { stepOrder: 'asc' },
              },
            },
          },
        },
      });
    });

    it('should successfully execute a workflow with data_transform step', async () => {
      const mockExecution = {
        id: 'exec-1',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        status: 'pending',
        currentStep: 1,
        metadata: { initialKey: 'initialVal' },
        workflow: {
          steps: [
            {
              id: 'step-1',
              stepOrder: 1,
              actionType: 'data_transform',
              config: { mapping: { resultKey: 'transformedValue' } },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      const result = await service.executeExecution('exec-1', 'tenant-1', 1);

      expect(result.status).toBe('completed');
      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec-1' },
        data: { status: 'running' },
      });
      expect(prismaMock.executionLog.create).toHaveBeenCalledWith({
        data: {
          executionId: 'exec-1',
          stepId: 'step-1',
          status: 'completed',
          output: {
            transformed: true,
            output: { resultKey: 'transformedValue' },
          },
        },
      });
      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec-1' },
        data: {
          status: 'completed',
          completedAt: expect.any(Date),
          metadata: {
            initialKey: 'initialVal',
            step_1: {
              transformed: true,
              output: { resultKey: 'transformedValue' },
            },
          },
        },
      });
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

    it('should handle failed step execution, record failure log, and rethrow error', async () => {
      const mockExecution = {
        id: 'exec-fail',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            {
              id: 'step-bad-http',
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.failing.org/data', method: 'POST' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      mockedAxios.mockRejectedValue(new Error('Connection refused'));

      await expect(service.executeExecution('exec-fail', 'tenant-1', 1)).rejects.toThrow(
        'HTTP POST to https://api.failing.org/data failed: Connection refused',
      );

      expect(prismaMock.executionLog.create).toHaveBeenCalledWith({
        data: {
          executionId: 'exec-fail',
          status: 'failed',
          error: 'HTTP POST to https://api.failing.org/data failed: Connection refused',
        },
      });
    });
  });

  describe('executeStep HTTP Request Step Behavior', () => {
    it('should return status code and response data on HTTP request step success', async () => {
      const mockExecution = {
        id: 'exec-http',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            {
              id: 'step-http',
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.example.com/status', method: 'GET' },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      mockedAxios.mockResolvedValue({
        status: 200,
        data: { ok: true, message: 'Success' },
      });

      const res = await service.executeExecution('exec-http', 'tenant-1', 1);

      expect(res.status).toBe('completed');
      expect(mockedAxios).toHaveBeenCalledWith({
        url: 'https://api.example.com/status',
        method: 'GET',
        headers: {},
        data: undefined,
        timeout: 5000,
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
