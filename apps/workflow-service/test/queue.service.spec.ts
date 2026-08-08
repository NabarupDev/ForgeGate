import { QueueService } from '../src/queue/queue.service';

describe('QueueService (Current Behavior Regression Tests)', () => {
  let queueService: QueueService;
  let engineServiceMock: any;
  let mockWorkflowQueue: any;
  let mockDlqQueue: any;

  beforeEach(() => {
    jest.clearAllMocks();

    engineServiceMock = {
      executeExecution: jest.fn(),
      markAsFailed: jest.fn(),
    };

    mockWorkflowQueue = {
      add: jest.fn(),
      getWaitingCount: jest.fn().mockResolvedValue(2),
      getActiveCount: jest.fn().mockResolvedValue(1),
      getCompletedCount: jest.fn().mockResolvedValue(10),
      getFailedCount: jest.fn().mockResolvedValue(0),
      close: jest.fn(),
    };

    mockDlqQueue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
      getJob: jest.fn(),
      close: jest.fn(),
    };

    queueService = new QueueService(engineServiceMock);
    (queueService as any).workflowQueue = mockWorkflowQueue;
    (queueService as any).dlqQueue = mockDlqQueue;
  });

  describe('addExecutionJob (Queue Insertion & Retry Config)', () => {
    it('should enqueue job with 3 attempts and 1000ms exponential backoff', async () => {
      mockWorkflowQueue.add.mockResolvedValue({ id: 'job-100' });

      const res = await queueService.addExecutionJob('exec-100', 'tenant-alpha');

      expect(res).toEqual({ jobId: 'job-100', status: 'enqueued' });
      expect(mockWorkflowQueue.add).toHaveBeenCalledWith(
        'execute-workflow',
        { executionId: 'exec-100', tenantId: 'tenant-alpha' },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    });
  });

  describe('DLQ Replay (replayDlqJob)', () => {
    it('should throw an error if DLQ job is not found', async () => {
      mockDlqQueue.getJob.mockResolvedValue(null);

      await expect(queueService.replayDlqJob('missing-job-id')).rejects.toThrow(
        'DLQ Job missing-job-id not found',
      );
    });

    it('should remove job from DLQ and re-enqueue to main workflow queue', async () => {
      const mockDlqJob = {
        id: 'dlq-job-1',
        data: { executionId: 'exec-dlq-replay', tenantId: 'tenant-dlq' },
        remove: jest.fn().mockResolvedValue(undefined),
      };

      mockDlqQueue.getJob.mockResolvedValue(mockDlqJob);
      mockWorkflowQueue.add.mockResolvedValue({ id: 'new-job-200' });

      const res = await queueService.replayDlqJob('dlq-job-1');

      expect(mockDlqQueue.getJob).toHaveBeenCalledWith('dlq-job-1');
      expect(mockDlqJob.remove).toHaveBeenCalled();
      expect(mockWorkflowQueue.add).toHaveBeenCalledWith(
        'execute-workflow',
        { executionId: 'exec-dlq-replay', tenantId: 'tenant-dlq' },
        expect.any(Object),
      );
      expect(res).toEqual({ jobId: 'new-job-200', status: 'enqueued' });
    });
  });

  describe('Queue Metrics', () => {
    it('should aggregate metrics from workflow and DLQ queues', async () => {
      mockDlqQueue.getJobs.mockResolvedValue([{ id: 'dlq-1' }]);

      const metrics = await queueService.getMetrics();

      expect(metrics).toEqual({
        activeJobs: 1,
        waitingJobs: 2,
        completedJobs: 10,
        failedJobs: 0,
        dlqCount: 1,
        totalQueueSize: 3,
      });
    });
  });
});
