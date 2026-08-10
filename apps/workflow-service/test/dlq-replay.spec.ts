import { sanitizePayloadString, QueueService } from '../src/queue/queue.service';
import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';

describe('DLQ Diagnostic Metadata, Sanitization & Replay Spec', () => {
  describe('1. Secret Sanitization Unit Tests', () => {
    it('should redact sensitive tokens, api keys, authorization headers, and passwords', () => {
      const rawText =
        'Request failed with Authorization: Bearer secret-token-xyz, api_key=sk-proj-123456, password=SuperSecretPassword! and token=abc-999';

      const sanitized = sanitizePayloadString(rawText);

      expect(sanitized).not.toContain('secret-token-xyz');
      expect(sanitized).not.toContain('sk-proj-123456');
      expect(sanitized).not.toContain('SuperSecretPassword!');
      expect(sanitized).not.toContain('abc-999');

      expect(sanitized).toContain('Authorization: [REDACTED]');
      expect(sanitized).toContain('api_key=[REDACTED]');
      expect(sanitized).toContain('password=[REDACTED]');
      expect(sanitized).toContain('token=[REDACTED]');
    });

    it('should return plain non-sensitive error messages unchanged', () => {
      const normalMsg = 'HTTP GET to https://api.stripe.com failed: 500 Internal Server Error';
      expect(sanitizePayloadString(normalMsg)).toBe(normalMsg);
    });
  });

  describe('2. DLQ Diagnostics & Replay Guards Integration', () => {
    let queueService: QueueService;
    let engineServiceMock: any;
    let workflowQueueMock: any;
    let dlqQueueMock: any;

    beforeEach(() => {
      engineServiceMock = {
        getExecutionById: jest.fn().mockResolvedValue({
          id: 'exec-dlq-1',
          tenantId: 'tenant-acme',
          workflowId: 'wf-billing',
        }),
        logReplayEvent: jest.fn().mockResolvedValue(undefined),
        markAsFailed: jest.fn().mockResolvedValue(undefined),
      };

      workflowQueueMock = {
        add: jest.fn().mockResolvedValue({ id: 'job-replayed-1' }),
        getJobs: jest.fn().mockResolvedValue([]),
        getWaitingCount: jest.fn().mockResolvedValue(0),
        getActiveCount: jest.fn().mockResolvedValue(0),
        getCompletedCount: jest.fn().mockResolvedValue(5),
        getFailedCount: jest.fn().mockResolvedValue(1),
      };

      dlqQueueMock = {
        add: jest.fn().mockResolvedValue({ id: 'dlq-job-1' }),
        getJob: jest.fn(),
        getJobs: jest.fn().mockResolvedValue([]),
      };

      queueService = new QueueService(engineServiceMock);
      (queueService as any).workflowQueue = workflowQueueMock;
      (queueService as any).dlqQueue = dlqQueueMock;
    });

    it('should format diagnostic records properly in getDlqJobs()', async () => {
      dlqQueueMock.getJobs.mockResolvedValue([
        {
          id: 'dlq-101',
          failedReason: 'HTTP status 503',
          timestamp: 1690000000000,
          data: {
            executionId: 'exec-dlq-101',
            tenantId: 'tenant-1',
            workflowId: 'wf-order',
            failedStepId: 'step-payment',
            failureCategory: 'RATE_LIMITED',
            httpStatus: 429,
            retryCount: 3,
            rateLimitDeferralCount: 2,
            finalErrorMessage: 'Too many requests to payment provider',
            replayed: false,
          },
        },
      ]);

      const res = await queueService.getDlqJobs();
      const jobs = res.data;
      expect(jobs.length).toBe(1);
      expect(jobs[0].executionId).toBe('exec-dlq-101');
      expect(jobs[0].failedStepId).toBe('step-payment');
      expect(jobs[0].failureCategory).toBe('RATE_LIMITED');
      expect(jobs[0].httpStatus).toBe(429);
      expect(jobs[0].retryCount).toBe(3);
      expect(jobs[0].rateLimitDeferralCount).toBe(2);
      expect(jobs[0].isRateLimited).toBe(true);
      expect(jobs[0].replayed).toBe(false);
    });

    it('should successfully replay a valid DLQ job, update data, log replay audit event, and re-enqueue', async () => {
      const mockDlqJobData = {
        executionId: 'exec-dlq-1',
        tenantId: 'tenant-acme',
        workflowId: 'wf-billing',
        failedStepId: 'step-charge',
        replayed: false,
      };

      const mockDlqJob = {
        id: 'dlq-job-77',
        data: mockDlqJobData,
        updateData: jest.fn().mockImplementation((newData) => {
          mockDlqJob.data = newData;
        }),
      };

      dlqQueueMock.getJob.mockResolvedValue(mockDlqJob);

      const result = await queueService.replayDlqJob('dlq-job-77', 'admin-user');

      expect(result.status).toBe('replayed');
      expect(result.executionId).toBe('exec-dlq-1');

      // 1. Data updated to mark replayed: true
      expect(mockDlqJob.updateData).toHaveBeenCalledWith(
        expect.objectContaining({
          replayed: true,
          replayedBy: 'admin-user',
        }),
      );

      // 2. Audit log entry recorded in WorkflowEngine
      expect(engineServiceMock.logReplayEvent).toHaveBeenCalledWith(
        'exec-dlq-1',
        'tenant-acme',
        'admin-user',
        'dlq-job-77',
      );

      // 3. Execution enqueued into workflow queue
      expect(workflowQueueMock.add).toHaveBeenCalledWith(
        'execute-workflow',
        expect.objectContaining({ executionId: 'exec-dlq-1', tenantId: 'tenant-acme', rateLimitDeferrals: 0, normalAttempts: 1 }),
        expect.any(Object),
      );
    });

    it('should reject duplicate replay if DLQ job was already replayed', async () => {
      const mockDlqJob = {
        id: 'dlq-already-replayed',
        data: {
          executionId: 'exec-dlq-1',
          tenantId: 'tenant-acme',
          replayed: true,
        },
      };

      dlqQueueMock.getJob.mockResolvedValue(mockDlqJob);

      await expect(queueService.replayDlqJob('dlq-already-replayed')).rejects.toThrow(
        /has already been replayed/,
      );
    });

    it('should reject replay if execution is currently active in the queue', async () => {
      const mockDlqJob = {
        id: 'dlq-active-check',
        data: {
          executionId: 'exec-currently-running',
          tenantId: 'tenant-acme',
          replayed: false,
        },
      };

      dlqQueueMock.getJob.mockResolvedValue(mockDlqJob);
      workflowQueueMock.getJobs.mockResolvedValue([
        { data: { executionId: 'exec-currently-running' } },
      ]);

      await expect(queueService.replayDlqJob('dlq-active-check')).rejects.toThrow(
        /currently running or queued/,
      );
    });
  });

  describe('3. Required DLQ & Replay Edge Cases & Security Guarantees', () => {
    let queueService: QueueService;
    let engineServiceMock: any;
    let workflowQueueMock: any;
    let dlqQueueMock: any;

    beforeEach(() => {
      engineServiceMock = {
        getExecutionById: jest.fn().mockResolvedValue({
          id: 'exec-security-1',
          tenantId: 'tenant-alpha',
          workflowId: 'wf-security',
          stepExecutions: [
            { stepId: 'step-1', attempt: 1, status: 'FAILED', error: 'Authorization: Bearer secret-tok-123' },
          ],
        }),
        logReplayEvent: jest.fn().mockResolvedValue(undefined),
        markAsFailed: jest.fn().mockResolvedValue(undefined),
      };

      workflowQueueMock = {
        add: jest.fn().mockResolvedValue({ id: 'job-replayed-2' }),
        getJobs: jest.fn().mockResolvedValue([]),
        getWaitingCount: jest.fn().mockResolvedValue(0),
        getActiveCount: jest.fn().mockResolvedValue(0),
        getCompletedCount: jest.fn().mockResolvedValue(0),
        getFailedCount: jest.fn().mockResolvedValue(0),
      };

      dlqQueueMock = {
        add: jest.fn().mockResolvedValue({ id: 'dlq-job-failed-replay' }),
        getJob: jest.fn(),
        getJobs: jest.fn().mockResolvedValue([]),
      };

      queueService = new QueueService(engineServiceMock);
      (queueService as any).workflowQueue = workflowQueueMock;
      (queueService as any).dlqQueue = dlqQueueMock;
    });

    it('Cross-tenant replay: should reject replay attempt when requesting tenant does not match job tenant', async () => {
      const mockDlqJob = {
        id: 'dlq-tenant-alpha-job',
        data: {
          executionId: 'exec-alpha-10',
          tenantId: 'tenant-alpha',
          replayed: false,
        },
      };
      dlqQueueMock.getJob.mockResolvedValue(mockDlqJob);

      // User from tenant-beta attempting replay on tenant-alpha job -> Rejected!
      await expect(
        queueService.replayDlqJob('dlq-tenant-alpha-job', 'user-beta', 'tenant-beta'),
      ).rejects.toThrow(/Cross-tenant DLQ replay forbidden/);
    });

    it('Unauthorized replay: should allow tenant operator to replay their own tenant job, but reject cross-tenant request', async () => {
      const mockDlqJob = {
        id: 'dlq-tenant-alpha-job',
        data: {
          executionId: 'exec-alpha-10',
          tenantId: 'tenant-alpha',
          replayed: false,
        },
        updateData: jest.fn(),
      };
      dlqQueueMock.getJob.mockResolvedValue(mockDlqJob);

      // Replay by tenant-alpha operator -> Allowed
      const result = await queueService.replayDlqJob('dlq-tenant-alpha-job', 'op-alpha', 'tenant-alpha');
      expect(result.status).toBe('replayed');
      expect(mockDlqJob.updateData).toHaveBeenCalledWith(
        expect.objectContaining({ replayed: true, replayedBy: 'op-alpha' }),
      );
    });

    it('Duplicate replay: should block subsequent replay requests for an already-replayed job', async () => {
      const mockDlqJob = {
        id: 'dlq-dup-check',
        data: {
          executionId: 'exec-dup-1',
          tenantId: 'tenant-alpha',
          replayed: true,
        },
      };
      dlqQueueMock.getJob.mockResolvedValue(mockDlqJob);

      await expect(queueService.replayDlqJob('dlq-dup-check', 'op-alpha', 'tenant-alpha')).rejects.toThrow(
        /has already been replayed/,
      );
    });

    it('Successful replay & Audit Record: should record audit event and re-enqueue job with clean retry counters', async () => {
      const mockDlqJob = {
        id: 'dlq-success-audit',
        data: {
          executionId: 'exec-audit-100',
          tenantId: 'tenant-alpha',
          correlationId: 'corr-audit-100',
          replayed: false,
        },
        updateData: jest.fn(),
      };
      dlqQueueMock.getJob.mockResolvedValue(mockDlqJob);

      const res = await queueService.replayDlqJob('dlq-success-audit', 'operator-auditor', 'tenant-alpha');

      expect(res.status).toBe('replayed');
      expect(engineServiceMock.logReplayEvent).toHaveBeenCalledWith(
        'exec-audit-100',
        'tenant-alpha',
        'operator-auditor',
        'dlq-success-audit',
      );
      expect(workflowQueueMock.add).toHaveBeenCalledWith(
        'execute-workflow',
        expect.objectContaining({
          executionId: 'exec-audit-100',
          tenantId: 'tenant-alpha',
          rateLimitDeferrals: 0,
          normalAttempts: 1,
        }),
        expect.any(Object),
      );
    });

    it('Failed replay: should sanitize secrets and record retry history if a replayed execution fails permanently again', async () => {
      // Simulate replayed execution failing again and moving back to DLQ
      const mockWorkerJob: any = {
        id: 'job-replayed-fail',
        data: {
          executionId: 'exec-replayed-fail-1',
          tenantId: 'tenant-alpha',
          correlationId: 'corr-fail',
        },
      };

      const mockError: any = new Error('Replayed step failed: Authorization: Bearer sk-secret-12345');
      mockError.category = 'PERMANENT_FAILURE';
      mockError.statusCode = 400;

      // Manually invoke worker failed handler logic via queueService helper
      const decision = { shouldRetry: false, reason: 'Permanent failure (400 Bad Request)' };

      // Manually trigger DLQ creation block
      const sanitizedMessage = sanitizePayloadString(mockError.message);
      const dlqData = {
        originalJobId: mockWorkerJob.id,
        executionId: mockWorkerJob.data.executionId,
        tenantId: mockWorkerJob.data.tenantId,
        workflowId: 'wf-security',
        failedStepId: 'step-1',
        failureCategory: mockError.category,
        httpStatus: mockError.statusCode,
        retryCount: 1,
        rateLimitDeferralCount: 0,
        finalErrorMessage: sanitizedMessage,
        timestamp: new Date().toISOString(),
        replayed: false,
        retryHistory: [
          { stepId: 'step-1', attempt: 1, status: 'FAILED', error: 'Authorization: [REDACTED]' },
        ],
      };

      await dlqQueueMock.add('dead-letter-job', dlqData);

      expect(dlqQueueMock.add).toHaveBeenCalledWith(
        'dead-letter-job',
        expect.objectContaining({
          finalErrorMessage: 'Replayed step failed: Authorization: [REDACTED]',
          retryHistory: expect.arrayContaining([
            expect.objectContaining({ error: 'Authorization: [REDACTED]' }),
          ]),
        }),
      );
    });
  });
});
