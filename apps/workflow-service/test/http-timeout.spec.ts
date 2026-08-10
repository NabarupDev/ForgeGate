import {
  resolveHttpTimeout,
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_GLOBAL_HTTP_TIMEOUT_MS,
} from '../src/workflow-engine/http-timeout-resolver';
import { classifyHttpError, HttpStepError } from '../src/workflow-engine/http-step-classifier';
import { calculateRetryDecision } from '../src/workflow-engine/http-retry-scheduler';
import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('HTTP Step Timeout Handling & State Persistence Unit Tests', () => {
  describe('1. Timeout Configuration & Validation (resolveHttpTimeout)', () => {
    it('should return default timeout (5000ms) when timeoutMs is undefined, null, or empty string', () => {
      expect(resolveHttpTimeout(undefined)).toBe(DEFAULT_HTTP_TIMEOUT_MS);
      expect(resolveHttpTimeout(null)).toBe(DEFAULT_HTTP_TIMEOUT_MS);
      expect(resolveHttpTimeout('')).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    });

    it('should return valid custom timeout (e.g. 10000ms)', () => {
      expect(resolveHttpTimeout(10000)).toBe(10000);
      expect(resolveHttpTimeout('10000')).toBe(10000);
      expect(resolveHttpTimeout(2500)).toBe(2500);
    });

    it('should enforce safe global maximum timeout (60000ms)', () => {
      expect(resolveHttpTimeout(120000)).toBe(MAX_GLOBAL_HTTP_TIMEOUT_MS);
      expect(resolveHttpTimeout(999999)).toBe(MAX_GLOBAL_HTTP_TIMEOUT_MS);
    });

    it('should reject invalid timeout values (negative, zero, non-numeric)', () => {
      expect(() => resolveHttpTimeout(-1000)).toThrow('Invalid timeoutMs configuration');
      expect(() => resolveHttpTimeout(0)).toThrow('Invalid timeoutMs configuration');
      expect(() => resolveHttpTimeout('not-a-number')).toThrow('Invalid timeoutMs configuration');
    });
  });

  describe('2. Timeout Classification & Retry Scheduling Integration', () => {
    it('should classify socket/request timeout errors into category TIMEOUT', () => {
      const err = classifyHttpError(
        { code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' },
        'https://slow.api/endpoint',
        'GET',
      );

      expect(err).toBeInstanceOf(HttpStepError);
      expect(err.category).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('request_timeout');
    });

    it('should schedule retry with backoff for TIMEOUT errors', () => {
      const timeoutError = classifyHttpError(
        { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' },
        'https://slow.api/endpoint',
        'POST',
      );

      const decision = calculateRetryDecision(timeoutError, 1, 0, new Date());

      expect(decision.shouldRetry).toBe(true);
      expect(decision.isRateLimitDeferral).toBe(false);
      expect(decision.newNormalAttemptCount).toBe(2);
      expect(decision.reason).toBe('transient_backoff_retry');
    });
  });

  describe('3. Engine Execution & StepExecution State Persistence (TIMED_OUT)', () => {
    let engineService: WorkflowEngineService;
    let prismaMock: any;

    beforeEach(() => {
      jest.clearAllMocks();

      prismaMock = {
        workflowExecution: {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

    it('should transition StepExecution status to TIMED_OUT when HTTP step times out', async () => {
      const mockWorkflowExecution = {
        id: 'exec-timeout-test',
        tenantId: 'tenant-1',
        workflowId: 'wf-timeout',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-http-timeout',
              order: 1,
              actionType: 'http_request',
              config: {
                url: 'https://slow.server/api',
                method: 'POST',
                timeoutMs: 3000,
              },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-timeout-1',
        executionId: 'exec-timeout-test',
        stepId: 'step-http-timeout',
        attempt: 1,
        status: 'RUNNING',
      });

      mockedAxios.mockRejectedValueOnce({
        code: 'ECONNABORTED',
        message: 'timeout of 3000ms exceeded',
      });

      await expect(
        engineService.executeExecution('exec-timeout-test', 'tenant-1', 1),
      ).rejects.toThrow('HTTP POST to https://slow.server/api failed: timeout of 3000ms exceeded');

      // Verify custom timeout (3000ms) was passed to axios
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://slow.server/api',
          method: 'POST',
          timeout: 3000,
        }),
      );

      // Verify StepExecution was updated with TIMED_OUT status
      expect(prismaMock.stepExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'se-timeout-1', status: 'RUNNING', workerId: expect.any(String) },
          data: expect.objectContaining({
            status: 'TIMED_OUT',
            error: expect.stringContaining('timeout of 3000ms exceeded'),
          }),
        }),
      );
    });

    it('should transition StepExecution status to FAILED for PERMANENT_FAILURE on invalid timeout config', async () => {
      const mockWorkflowExecution = {
        id: 'exec-invalid-timeout-test',
        tenantId: 'tenant-1',
        workflowId: 'wf-invalid-timeout',
        currentStep: 1,
        status: 'running',
        workflow: {
          steps: [
            {
              id: 'step-invalid-timeout',
              order: 1,
              actionType: 'http_request',
              config: {
                url: 'https://api.example.com',
                timeoutMs: -500, // Invalid negative timeout
              },
            },
          ],
        },
      };

      prismaMock.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      prismaMock.stepExecution.findFirst.mockResolvedValue(null);
      prismaMock.stepExecution.create.mockResolvedValue({
        id: 'se-invalid-timeout-1',
        executionId: 'exec-invalid-timeout-test',
        stepId: 'step-invalid-timeout',
        attempt: 1,
        status: 'RUNNING',
      });

      await expect(
        engineService.executeExecution('exec-invalid-timeout-test', 'tenant-1', 1),
      ).rejects.toThrow('Invalid timeoutMs configuration: -500');

      expect(prismaMock.stepExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'se-invalid-timeout-1', status: 'RUNNING', workerId: expect.any(String) },
          data: expect.objectContaining({
            status: 'FAILED',
            error: expect.stringContaining('Invalid timeoutMs configuration'),
          }),
        }),
      );
    });
  });

  describe('4. Crash Recovery Integration for Stale RUNNING / Timed-Out Steps', () => {
    let engineService: WorkflowEngineService;
    let prismaMock: any;

    beforeEach(() => {
      jest.clearAllMocks();

      prismaMock = {
        stepExecution: {
          findMany: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        workflowExecution: {
          update: jest.fn().mockResolvedValue({}),
        },
      };

      engineService = new WorkflowEngineService(prismaMock);
    });

    it('should recover stale RUNNING steps whose lease expired and transition status to TIMED_OUT', async () => {
      const expiredHeartbeat = new Date(Date.now() - 45000); // Exceeds 30s lease
      prismaMock.stepExecution.findMany.mockResolvedValue([
        {
          id: 'se-stale-timeout',
          executionId: 'exec-recovery-test',
          status: 'RUNNING',
          startedAt: expiredHeartbeat,
          heartbeatAt: expiredHeartbeat,
          execution: { id: 'exec-recovery-test', tenantId: 'tenant-1', status: 'running' },
        },
      ]);

      const recovered = await engineService.findAndMarkStaleStepExecutions(30000);

      expect(recovered).toHaveLength(1);
      expect(recovered[0].executionId).toBe('exec-recovery-test');

      // Verify old worker's step status was transitioned from RUNNING to TIMED_OUT
      expect(prismaMock.stepExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'se-stale-timeout', status: 'RUNNING' },
          data: expect.objectContaining({
            status: 'TIMED_OUT',
            error: 'Worker lease expired (crash detected)',
          }),
        }),
      );

      // Verify workflow execution status transitioned to retrying
      expect(prismaMock.workflowExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'exec-recovery-test' },
          data: { status: 'retrying' },
        }),
      );
    });
  });
});
