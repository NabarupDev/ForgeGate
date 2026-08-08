import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import { QueueService } from '../src/queue/queue.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('Crash-Safe Workflow Step Recovery Tests', () => {
  let engineService: WorkflowEngineService;
  let queueService: QueueService;
  let prismaMock: any;
  let mockWorkflowQueue: any;
  let mockDlqQueue: any;

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
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'step-exec-uuid-99' }),
        update: jest.fn().mockResolvedValue({ id: 'step-exec-uuid-99' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    mockWorkflowQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-rec-1' }),
      getJobs: jest.fn().mockResolvedValue([]),
      getWaitingCount: jest.fn().mockResolvedValue(0),
      getActiveCount: jest.fn().mockResolvedValue(0),
      getCompletedCount: jest.fn().mockResolvedValue(0),
      getFailedCount: jest.fn().mockResolvedValue(0),
      close: jest.fn(),
    };

    mockDlqQueue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
      close: jest.fn(),
    };

    engineService = new WorkflowEngineService(prismaMock as any);
    queueService = new QueueService(engineService);
    (queueService as any).workflowQueue = mockWorkflowQueue;
    (queueService as any).dlqQueue = mockDlqQueue;
  });

  describe('Scenario A: Worker crashes before step starts', () => {
    it('should claim PENDING step and execute to completion', async () => {
      const mockExecution = {
        id: 'exec-crash-before',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        status: 'pending',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            {
              id: 'step-pending',
              stepOrder: 1,
              actionType: 'data_transform',
              config: { mapping: { test: 'ok' } },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null); // Not completed yet
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      const res = await engineService.executeExecution('exec-crash-before', 'tenant-1', 1);

      expect(res.status).toBe('completed');
      expect(prismaMock.stepExecution.create).toHaveBeenCalledWith({
        data: {
          executionId: 'exec-crash-before',
          stepId: 'step-pending',
          attempt: 1,
          status: 'PENDING',
          input: {},
          workerId: expect.any(String),
        },
      });
      expect(prismaMock.stepExecution.updateMany).toHaveBeenCalledWith({
        where: { id: 'step-exec-uuid-99', status: 'PENDING' },
        data: {
          status: 'RUNNING',
          workerId: expect.any(String),
          startedAt: expect.any(Date),
          heartbeatAt: expect.any(Date),
        },
      });
    });
  });

  describe('Scenario B & C: Worker crashes while step is running / Stale RUNNING step recovery', () => {
    it('should identify stale RUNNING step and transition old step to TIMED_OUT with crash error', async () => {
      const sixtySecondsAgo = new Date(Date.now() - 60000);
      const mockStaleStepExec = {
        id: 'stale-exec-1',
        executionId: 'exec-stale-1',
        stepId: 'step-stale',
        status: 'RUNNING',
        heartbeatAt: sixtySecondsAgo,
        startedAt: sixtySecondsAgo,
        execution: {
          id: 'exec-stale-1',
          tenantId: 'tenant-1',
          status: 'running',
        },
      };

      prismaMock.stepExecution.findMany.mockResolvedValue([mockStaleStepExec]);
      prismaMock.stepExecution.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.workflowExecution.update.mockResolvedValue({});

      const staleList = await engineService.findAndMarkStaleStepExecutions(30000);

      expect(staleList).toEqual([{ executionId: 'exec-stale-1', tenantId: 'tenant-1' }]);
      expect(prismaMock.stepExecution.updateMany).toHaveBeenCalledWith({
        where: { id: 'stale-exec-1', status: 'RUNNING' },
        data: {
          status: 'TIMED_OUT',
          finishedAt: expect.any(Date),
          error: 'Worker lease expired (crash detected)',
        },
      });
      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec-stale-1' },
        data: { status: 'retrying' },
      });
    });

    it('should recover stale executions and re-enqueue them via QueueService', async () => {
      const sixtySecondsAgo = new Date(Date.now() - 60000);
      const mockStaleStepExec = {
        id: 'stale-exec-2',
        executionId: 'exec-stale-2',
        stepId: 'step-stale-2',
        status: 'RUNNING',
        heartbeatAt: sixtySecondsAgo,
        execution: { id: 'exec-stale-2', tenantId: 'tenant-1', status: 'running' },
      };

      prismaMock.stepExecution.findMany.mockResolvedValue([mockStaleStepExec]);
      prismaMock.stepExecution.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.workflowExecution.update.mockResolvedValue({});
      mockWorkflowQueue.getJobs.mockResolvedValue([]); // No active job

      const recResult = await queueService.recoverStaleExecutions(30000);

      expect(recResult).toEqual({
        staleCount: 1,
        reenqueuedCount: 1,
        reenqueuedIds: ['exec-stale-2'],
      });
      expect(mockWorkflowQueue.add).toHaveBeenCalledWith(
        'execute-workflow',
        expect.objectContaining({ executionId: 'exec-stale-2', tenantId: 'tenant-1' }),
        expect.any(Object),
      );
    });
  });

  describe('Scenario D: Duplicate recovery attempt', () => {
    it('should skip re-enqueueing if job for executionId is already queued in BullMQ', async () => {
      const sixtySecondsAgo = new Date(Date.now() - 60000);
      const mockStaleStepExec = {
        id: 'stale-exec-3',
        executionId: 'exec-stale-dup',
        stepId: 'step-stale-3',
        status: 'RUNNING',
        heartbeatAt: sixtySecondsAgo,
        execution: { id: 'exec-stale-dup', tenantId: 'tenant-1', status: 'running' },
      };

      prismaMock.stepExecution.findMany.mockResolvedValue([mockStaleStepExec]);
      prismaMock.stepExecution.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.workflowExecution.update.mockResolvedValue({});

      // Mock BullMQ already having an active job for exec-stale-dup
      mockWorkflowQueue.getJobs.mockResolvedValue([
        { id: 'job-existing', data: { executionId: 'exec-stale-dup', tenantId: 'tenant-1' } },
      ]);

      const recResult = await queueService.recoverStaleExecutions(30000);

      expect(recResult).toEqual({
        staleCount: 1,
        reenqueuedCount: 0,
        reenqueuedIds: [],
      });
      expect(mockWorkflowQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('Scenario F: Already-completed step is not executed again accidentally', () => {
    it('should skip step execution if StepExecution already has status SUCCEEDED and reuse output', async () => {
      const mockExecution = {
        id: 'exec-completed-step-1',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        status: 'running',
        currentStep: 1,
        metadata: {},
        workflow: {
          steps: [
            {
              id: 'step-already-done',
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.example.com/data', method: 'GET' },
            },
            {
              id: 'step-next',
              stepOrder: 2,
              actionType: 'data_transform',
              config: { mapping: { res: 'ok' } },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      // Step 1 was already SUCCEEDED
      prismaMock.stepExecution.findFirst
        .mockResolvedValueOnce({
          id: 'step-exec-1',
          executionId: 'exec-completed-step-1',
          stepId: 'step-already-done',
          status: 'SUCCEEDED',
          output: { statusCode: 200, data: { cached: true } },
        })
        .mockResolvedValueOnce(null); // Step 2 not yet done

      const res = await engineService.executeExecution('exec-completed-step-1', 'tenant-1', 2);

      expect(res.status).toBe('completed');
      // Axios should NOT be called for step 1!
      expect(mockedAxios).not.toHaveBeenCalled();

      // Step 2 should be executed using Step 1's cached output
      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec-completed-step-1' },
        data: {
          status: 'completed',
          completedAt: expect.any(Date),
          metadata: {
            step_1: { statusCode: 200, data: { cached: true } },
            step_2: { transformed: true, output: { res: 'ok' } },
          },
        },
      });
    });
  });

  describe('Scenario E: End-to-end successful recovery sequence', () => {
    it('should seamlessly recover workflow execution from crash state', async () => {
      // Step 1 completed, Step 2 timed out during crash
      const mockExecution = {
        id: 'exec-e2e-rec',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        status: 'retrying',
        currentStep: 1,
        metadata: { step_1: { result: 'step1-ok' } },
        workflow: {
          steps: [
            {
              id: 'step-1-completed',
              stepOrder: 1,
              actionType: 'data_transform',
              config: {},
            },
            {
              id: 'step-2-recovering',
              stepOrder: 2,
              actionType: 'data_transform',
              config: { mapping: { step2: 'done' } },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockExecution);
      prismaMock.workflowExecution.update.mockResolvedValue({});
      prismaMock.executionLog.create.mockResolvedValue({});

      // Step 1 is SUCCEEDED, Step 2 is not
      prismaMock.stepExecution.findFirst
        .mockResolvedValueOnce({
          id: 'step-exec-done-1',
          status: 'SUCCEEDED',
          output: { result: 'step1-ok' },
        })
        .mockResolvedValueOnce(null);

      const res = await engineService.executeExecution('exec-e2e-rec', 'tenant-1', 2);

      expect(res.status).toBe('completed');
      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec-e2e-rec' },
        data: {
          status: 'completed',
          completedAt: expect.any(Date),
          metadata: {
            step_1: { result: 'step1-ok' },
            step_2: { transformed: true, output: { step2: 'done' } },
          },
        },
      });
    });
  });
});
