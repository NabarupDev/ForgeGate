import { ExecutionService } from '../src/execution/execution.service';
import { NotFoundException } from '@nestjs/common';

describe('ExecutionService (Current Behavior Regression Tests)', () => {
  let service: ExecutionService;
  let prismaMock: any;
  let queueServiceMock: any;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaMock = {
      workflow: {
        findUnique: jest.fn(),
      },
      workflowExecution: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    };

    queueServiceMock = {
      addExecutionJob: jest.fn(),
    };

    service = new ExecutionService(prismaMock as any, queueServiceMock as any);
  });

  describe('triggerWorkflow', () => {
    it('should throw NotFoundException if workflow does not exist', async () => {
      prismaMock.workflow.findUnique.mockResolvedValue(null);

      await expect(
        service.triggerWorkflow('non-existent-wf', { tenantId: 'tenant-1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create execution record with status pending and enqueue execution job', async () => {
      const mockWorkflow = { id: 'wf-100', tenantId: 'tenant-default' };
      prismaMock.workflow.findUnique.mockResolvedValue(mockWorkflow);

      const mockCreatedExecution = {
        id: 'exec-999',
        workflowId: 'wf-100',
        tenantId: 'tenant-custom',
        status: 'pending',
        metadata: { inputParam: 'val' },
      };
      prismaMock.workflowExecution.create.mockResolvedValue(mockCreatedExecution);

      queueServiceMock.addExecutionJob.mockResolvedValue({
        jobId: 'job-999',
        status: 'enqueued',
      });

      const res = await service.triggerWorkflow('wf-100', {
        tenantId: 'tenant-custom',
        metadata: { inputParam: 'val' },
      });

      expect(prismaMock.workflowExecution.create).toHaveBeenCalledWith({
        data: {
          workflowId: 'wf-100',
          tenantId: 'tenant-custom',
          status: 'pending',
          metadata: { inputParam: 'val' },
        },
      });

      expect(queueServiceMock.addExecutionJob).toHaveBeenCalledWith('exec-999', 'tenant-custom');

      expect(res).toEqual({
        executionId: 'exec-999',
        status: 'pending',
        queue: { jobId: 'job-999', status: 'enqueued' },
      });
    });
  });

  describe('getExecution', () => {
    it('should throw NotFoundException if execution id does not exist', async () => {
      prismaMock.workflowExecution.findUnique.mockResolvedValue(null);

      await expect(service.getExecution('invalid-exec-id')).rejects.toThrow(NotFoundException);
    });

    it('should return execution details with logs when found', async () => {
      const mockExecution = {
        id: 'exec-valid',
        status: 'completed',
        workflow: { name: 'Sample Workflow' },
        logs: [{ status: 'completed', output: {} }],
      };
      prismaMock.workflowExecution.findUnique.mockResolvedValue(mockExecution);

      const res = await service.getExecution('exec-valid');
      expect(res).toEqual(mockExecution);
    });
  });
});
