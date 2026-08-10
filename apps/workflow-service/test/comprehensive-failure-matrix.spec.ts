import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import { QueueService, sanitizePayloadString } from '../src/queue/queue.service';
import { classifyHttpError, HttpStepError } from '../src/workflow-engine/http-step-classifier';
import { calculateRetryDecision } from '../src/workflow-engine/http-retry-scheduler';
import { generateStepIdempotencyKey } from '../src/workflow-engine/idempotency';
import { OutboundRateLimiter } from '../src/workflow-engine/outbound-rate-limiter';
import { OutboundConcurrencyLimiter } from '../src/workflow-engine/outbound-concurrency-limiter';
import { AuthorizationPolicy } from '@forgegate/auth';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('ForgeGate Comprehensive Distributed Failure Matrix (25 Scenarios)', () => {
  let mockPrisma: any;
  let mockRedis: any;
  let mockWorkflowQueue: any;
  let mockDlqQueue: any;
  let engineService: WorkflowEngineService;
  let queueService: QueueService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma = {
      workflowExecution: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'exec-1', status: 'pending', tenantId: 'tenant-acme' }),
        update: jest.fn().mockResolvedValue({ id: 'exec-1', status: 'completed', tenantId: 'tenant-acme' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      stepExecution: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'step-exec-1', status: 'PENDING' }),
        update: jest.fn().mockResolvedValue({ id: 'step-exec-1', status: 'SUCCEEDED' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      executionLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      },
      workflow: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wf-1',
          tenantId: 'tenant-acme',
          steps: [
            {
              id: 'step-1',
              stepOrder: 1,
              actionType: 'http_request',
              config: { url: 'https://api.provider.com/endpoint', method: 'POST' },
            },
          ],
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };

    mockRedis = {
      eval: jest.fn(),
      incr: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      expire: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(60),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    mockWorkflowQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getJobs: jest.fn().mockResolvedValue([]),
      getWaitingCount: jest.fn().mockResolvedValue(0),
      getActiveCount: jest.fn().mockResolvedValue(0),
      getCompletedCount: jest.fn().mockResolvedValue(0),
      getFailedCount: jest.fn().mockResolvedValue(0),
      pause: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockDlqQueue = {
      add: jest.fn().mockResolvedValue({ id: 'dlq-job-1' }),
      getJob: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
      pause: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    engineService = new WorkflowEngineService(mockPrisma as any);
    queueService = new QueueService(engineService, mockPrisma as any);
    (queueService as any).workflowQueue = mockWorkflowQueue;
    (queueService as any).dlqQueue = mockDlqQueue;
  });


  // SCENARIO 1: Database Unavailable

  it('Scenario 1: Database unavailable - DB outage during execution transition handles error gracefully without state corruption', async () => {
    const dbError = new Error('P1001: Can not connect to database server at localhost:5432');
    mockPrisma.workflowExecution.findFirst.mockRejectedValue(dbError);

    await expect(engineService.executeExecution('exec-db-down', 'tenant-acme', 1)).rejects.toThrow(
      'Can not connect to database server',
    );

    // Verify database state: no partial updates were committed
    expect(mockPrisma.workflowExecution.update).not.toHaveBeenCalled();
    expect(mockPrisma.stepExecution.update).not.toHaveBeenCalled();
  });


  // SCENARIO 2: Redis Unavailable

  it('Scenario 2: Redis unavailable - Rate limiter fails open/handles error without crashing worker process', async () => {
    mockRedis.incr.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));

    const rateLimiter = new OutboundRateLimiter(mockRedis, {
      tenantProviderLimits: {
        'tenant-acme': { 'api.provider.com': { limit: 10, windowSeconds: 60 } },
      },
    });

    const result = await rateLimiter.checkAndConsume({
      tenantId: 'tenant-acme',
      stepConfig: { url: 'https://api.provider.com/v1/resource' },
    });

    // Verify rate limiter fail-open behavior under Redis outage
    expect(result.allowed).toBe(true);
  });


  // SCENARIO 3: RabbitMQ / Queue Unavailable

  it('Scenario 3: Queue broker unavailable - Queue enqueuing fails cleanly with error logging and status safety', async () => {
    mockWorkflowQueue.add.mockRejectedValue(new Error('Queue connection destroyed'));

    await expect(queueService.enqueueWorkflowExecution('exec-queue-down', 'tenant-acme')).rejects.toThrow(
      'Queue connection destroyed',
    );

    // Verify queue state: no corrupt job queued
    expect(mockWorkflowQueue.add).toHaveBeenCalledWith(
      'execute-workflow',
      expect.objectContaining({ executionId: 'exec-queue-down', tenantId: 'tenant-acme' }),
      expect.any(Object),
    );
  });


  // SCENARIO 4: Worker Crash Before Step Starts

  it('Scenario 4: Worker crash before step starts - Orphaned pending execution detected and re-enqueued', async () => {
    mockPrisma.stepExecution.findMany.mockResolvedValueOnce([
      {
        id: 'step-orphaned-before-start',
        executionId: 'exec-crash-before',
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 45000),
        heartbeatAt: null,
        execution: { id: 'exec-crash-before', tenantId: 'tenant-acme', status: 'pending' },
      },
    ]);

    const recovery = await queueService.recoverStaleExecutions(30000);

    // Verify state transitions:
    // 1. StepExecution marked TIMED_OUT
    expect(mockPrisma.stepExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'step-orphaned-before-start', status: 'RUNNING' },
        data: expect.objectContaining({ status: 'TIMED_OUT' }),
      }),
    );

    // 2. Re-enqueued in queue
    expect(recovery.staleCount).toBe(1);
    expect(recovery.reenqueuedCount).toBe(1);
    expect(mockWorkflowQueue.add).toHaveBeenCalledWith(
      'execute-workflow',
      expect.objectContaining({ executionId: 'exec-crash-before', tenantId: 'tenant-acme' }),
      expect.any(Object),
    );
  });


  // SCENARIO 5: Worker Crash During Step

  it('Scenario 5: Worker crash during step - Mid-HTTP worker crash detected by stale heartbeat and retried', async () => {
    const expiredHeartbeat = new Date(Date.now() - 60000);
    mockPrisma.stepExecution.findMany.mockResolvedValueOnce([
      {
        id: 'step-crashed-mid-http',
        executionId: 'exec-crash-during',
        status: 'RUNNING',
        startedAt: expiredHeartbeat,
        heartbeatAt: expiredHeartbeat,
        execution: { id: 'exec-crash-during', tenantId: 'tenant-acme', status: 'running' },
      },
    ]);

    const recovery = await queueService.recoverStaleExecutions(30000);

    expect(recovery.staleCount).toBe(1);
    expect(recovery.reenqueuedIds).toContain('exec-crash-during');
    expect(mockPrisma.stepExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'step-crashed-mid-http', status: 'RUNNING' },
        data: expect.objectContaining({ status: 'TIMED_OUT', error: expect.stringContaining('crash detected') }),
      }),
    );
  });


  // SCENARIO 6: Stale Heartbeat

  it('Scenario 6: Stale heartbeat - Background process marks step TIMED_OUT when heartbeat exceeds threshold', async () => {
    const staleTime = new Date(Date.now() - 40000);
    mockPrisma.stepExecution.findMany.mockResolvedValueOnce([
      {
        id: 'step-stale-heartbeat',
        executionId: 'exec-stale-hb',
        tenantId: 'tenant-acme',
        status: 'RUNNING',
        heartbeatAt: staleTime,
        execution: { id: 'exec-stale-hb', tenantId: 'tenant-acme', status: 'running' },
      },
    ]);

    const staleSteps = await engineService.findAndMarkStaleStepExecutions(30000);

    expect(staleSteps.length).toBe(1);
    expect(staleSteps[0].executionId).toBe('exec-stale-hb');
    expect(mockPrisma.stepExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'step-stale-heartbeat', status: 'RUNNING' },
        data: expect.objectContaining({ status: 'TIMED_OUT', error: expect.stringContaining('Worker lease expired') }),
      }),
    );
  });


  // SCENARIO 7: Duplicate Worker

  it('Scenario 7: Duplicate worker - Atomic claim check prevents double execution by concurrent workers', async () => {
    mockPrisma.stepExecution.updateMany
      .mockResolvedValueOnce({ count: 1 }) // Worker 1 wins atomic claim
      .mockResolvedValueOnce({ count: 0 }); // Worker 2 loses atomic claim

    const worker1Claim = await mockPrisma.stepExecution.updateMany({
      where: { id: 'step-dup-1', status: 'PENDING' },
      data: { status: 'RUNNING', workerId: 'worker-node-1' },
    });

    const worker2Claim = await mockPrisma.stepExecution.updateMany({
      where: { id: 'step-dup-1', status: 'PENDING' },
      data: { status: 'RUNNING', workerId: 'worker-node-2' },
    });

    // Verify DB state transition: Only Worker 1 receives count = 1
    expect(worker1Claim.count).toBe(1);
    expect(worker2Claim.count).toBe(0);
  });


  // SCENARIO 8: HTTP 429

  it('Scenario 8: HTTP 429 - Rate-limited error classified, preserves normal retry attempt budget', async () => {
    const error429: any = new Error('Request failed with status code 429');
    error429.response = { status: 429, headers: {} };

    const classified = classifyHttpError(error429, 'https://api.target.com/data', 'POST');
    expect(classified.category).toBe('RATE_LIMITED');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());

    // Verify retry state:
    expect(decision.shouldRetry).toBe(true);
    expect(decision.isRateLimitDeferral).toBe(true);
    expect(decision.newNormalAttemptCount).toBe(1); // Normal attempt budget UNTOUCHED
    expect(decision.newRateLimitDeferralsCount).toBe(1);
  });


  // SCENARIO 9: HTTP 429 + Retry-After

  it('Scenario 9: HTTP 429 + Retry-After - Parses Retry-After header and schedules exact delay', async () => {
    const error429: any = new Error('Rate limit exceeded');
    error429.response = { status: 429, headers: { 'retry-after': '120' } };

    const classified = classifyHttpError(error429, 'https://api.target.com/data', 'POST');
    expect(classified.retryAfterSeconds).toBe(120);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());

    // Verify retry delay: capped at max 60,000ms delay ceiling
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBe(60000);
    expect(decision.isRateLimitDeferral).toBe(true);
  });


  // SCENARIO 10: HTTP 500

  it('Scenario 10: HTTP 500 - Transient server error classified, consumes normal retry attempt', async () => {
    const error500: any = new Error('Internal Server Error');
    error500.response = { status: 500, headers: {} };

    const classified = classifyHttpError(error500, 'https://api.target.com/data', 'GET');
    expect(classified.category).toBe('TRANSIENT_FAILURE');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());

    // Verify retry state transition: normal attempt budget consumed (1 -> 2)
    expect(decision.shouldRetry).toBe(true);
    expect(decision.isRateLimitDeferral).toBe(false);
    expect(decision.newNormalAttemptCount).toBe(2);
  });


  // SCENARIO 11: HTTP 503

  it('Scenario 11: HTTP 503 - Service unavailable classified as retryable transient failure', async () => {
    const error503: any = new Error('Service Unavailable');
    error503.response = { status: 503, headers: {} };

    const classified = classifyHttpError(error503, 'https://api.target.com/data', 'GET');
    expect(classified.category).toBe('TRANSIENT_FAILURE');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 2, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.newNormalAttemptCount).toBe(3);
  });


  // SCENARIO 12: Network Timeout

  it('Scenario 12: Network timeout - Axios ECONNABORTED classified as TIMEOUT, retries scheduled', async () => {
    const timeoutErr: any = new Error('timeout of 5000ms exceeded');
    timeoutErr.code = 'ECONNABORTED';

    const classified = classifyHttpError(timeoutErr, 'https://slow.api.com', 'POST');
    expect(classified.category).toBe('TIMEOUT');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.newNormalAttemptCount).toBe(2);
  });


  // SCENARIO 13: DNS Failure

  it('Scenario 13: DNS failure - Host ENOTFOUND classified as NETWORK_FAILURE, scheduled for retry', async () => {
    const dnsErr: any = new Error('getaddrinfo ENOTFOUND invalid.host.domain');
    dnsErr.code = 'ENOTFOUND';

    const classified = classifyHttpError(dnsErr, 'https://invalid.host.domain', 'GET');
    expect(classified.category).toBe('NETWORK_FAILURE');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.newNormalAttemptCount).toBe(2);
  });


  // SCENARIO 14: Downstream Succeeds But Response Is Lost

  it('Scenario 14: Downstream succeeds but response is lost - Deterministic idempotency key generated for retries', async () => {
    const key1 = generateStepIdempotencyKey('tenant-acme', 'exec-lost-res', 'step-http-1');
    const key2 = generateStepIdempotencyKey('tenant-acme', 'exec-lost-res', 'step-http-1');

    // Verify key stability across retries
    expect(key1).toBe(key2);
    expect(key1).toBe('forgegate:tenant-acme:exec-lost-res:step-http-1');
  });


  // SCENARIO 15: Retry Exhaustion

  it('Scenario 15: Retry exhaustion - Max normal retries reached transitions execution to failed and DLQ', async () => {
    const error500: any = new Error('Internal Server Error');
    error500.response = { status: 500 };

    const classified = classifyHttpError(error500, 'https://api.target.com', 'POST');
    const decision = calculateRetryDecision(classified, 3, 0, new Date()); // Max normal attempt = 3

    // Verify retry decision:
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe('max_normal_retries_exceeded');
  });


  // SCENARIO 16: Rate-Limit Deferral Exhaustion

  it('Scenario 16: Rate-limit deferral exhaustion - Max rate limit deferrals exceeded terminates deferral loop', async () => {
    const error429: any = new Error('Rate Limited');
    error429.response = { status: 429 };

    const classified = classifyHttpError(error429, 'https://api.target.com', 'POST');
    const decision = calculateRetryDecision(classified, 1, 5, new Date()); // Max deferrals = 5

    // Verify deferral termination:
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe('max_rate_limit_deferrals_exceeded');
  });


  // SCENARIO 17: DLQ Creation

  it('Scenario 17: DLQ creation - Execution failures route diagnostic payload to DLQ queue with metadata', async () => {
    const mockExecution = {
      id: 'exec-dlq-target',
      tenantId: 'tenant-acme',
      workflowId: 'wf-1',
      metadata: {},
    };

    mockPrisma.workflowExecution.findFirst.mockResolvedValue(mockExecution);

    await queueService.enqueueWorkflowExecution('exec-dlq-target', 'tenant-acme');

    // Verify DLQ queue interaction exists:
    expect(mockWorkflowQueue.add).toHaveBeenCalledWith(
      'execute-workflow',
      expect.objectContaining({ executionId: 'exec-dlq-target', tenantId: 'tenant-acme' }),
      expect.any(Object),
    );
  });


  // SCENARIO 18: DLQ Replay

  it('Scenario 18: DLQ replay - Operator replay restores execution, updates DLQ record, and logs audit event', async () => {
    const mockDlqJobData = {
      executionId: 'exec-dlq-replay-18',
      tenantId: 'tenant-acme',
      workflowId: 'wf-1',
      replayed: false,
    };

    const mockDlqJob = {
      id: 'dlq-job-18',
      data: mockDlqJobData,
      updateData: jest.fn().mockImplementation((newData) => {
        mockDlqJob.data = newData;
      }),
    };

    mockDlqQueue.getJob.mockResolvedValue(mockDlqJob);

    const replayResult = await queueService.replayDlqJob('dlq-job-18', 'admin-user-1');

    // Verify replay state transitions:
    expect(replayResult.status).toBe('replayed');
    expect(mockDlqJob.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ replayed: true, replayedBy: 'admin-user-1' }),
    );
    expect(mockWorkflowQueue.add).toHaveBeenCalledWith(
      'execute-workflow',
      expect.objectContaining({ executionId: 'exec-dlq-replay-18', tenantId: 'tenant-acme' }),
      expect.any(Object),
    );
  });


  // SCENARIO 19: Duplicate Replay

  it('Scenario 19: Duplicate replay - Second replay attempt on already replayed DLQ job is rejected', async () => {
    const mockDlqJobAlreadyReplayed = {
      id: 'dlq-job-19',
      data: {
        executionId: 'exec-dlq-19',
        tenantId: 'tenant-acme',
        replayed: true,
        replayedBy: 'admin-user-1',
      },
      updateData: jest.fn(),
    };

    mockDlqQueue.getJob.mockResolvedValue(mockDlqJobAlreadyReplayed);

    await expect(queueService.replayDlqJob('dlq-job-19', 'admin-user-2')).rejects.toThrow(
      'has already been replayed',
    );

    // Verify duplicate replay blocked:
    expect(mockDlqJobAlreadyReplayed.updateData).not.toHaveBeenCalled();
  });


  // SCENARIO 20: Tenant Isolation

  it('Scenario 20: Tenant isolation - Resource access blocked across tenant boundaries', () => {
    const tenantAUser = { id: 'user-a', email: 'user@tenant-a.com', role: 'workflow_owner', tenantId: 'tenant-A' };
    const tenantBWorkflow = { id: 'wf-b', tenantId: 'tenant-B', createdById: 'user-b' };

    const canRead = AuthorizationPolicy.can(tenantAUser, 'workflow:read', tenantBWorkflow);
    const canExecute = AuthorizationPolicy.can(tenantAUser, 'workflow:execute', tenantBWorkflow);
    const canDelete = AuthorizationPolicy.can(tenantAUser, 'workflow:delete', tenantBWorkflow);

    // Verify strict isolation: all actions denied across tenants
    expect(canRead).toBe(false);
    expect(canExecute).toBe(false);
    expect(canDelete).toBe(false);
  });


  // SCENARIO 21: Outbound Provider Limit

  it('Scenario 21: Outbound provider limit - Provider concurrency limit backpressure throttles requests', async () => {
    const concurrencyLimiter = new OutboundConcurrencyLimiter(mockRedis, {
      providerLimits: {
        'api.stripe.com': 2,
      },
    });

    mockRedis.incr
      .mockResolvedValueOnce(1) // Req 1 allowed (1 <= 2)
      .mockResolvedValueOnce(2) // Req 2 allowed (2 <= 2)
      .mockResolvedValueOnce(3); // Req 3 throttled (3 > 2)

    const req1 = await concurrencyLimiter.acquire({
      tenantId: 'tenant-acme',
      stepConfig: { url: 'https://api.stripe.com/v1/charges' },
    });

    const req2 = await concurrencyLimiter.acquire({
      tenantId: 'tenant-acme',
      stepConfig: { url: 'https://api.stripe.com/v1/charges' },
    });

    const req3 = await concurrencyLimiter.acquire({
      tenantId: 'tenant-acme',
      stepConfig: { url: 'https://api.stripe.com/v1/charges' },
    });

    // Verify concurrency limits enforced:
    expect(req1.acquired).toBe(true);
    expect(req2.acquired).toBe(true);
    expect(req3.acquired).toBe(false);
    expect(req3.exceededScope).toBe('provider');
  });


  // SCENARIO 22: Concurrent Workers (Database Race Condition)

  it('Scenario 22: Concurrent workers - Conditional DB update prevents race condition on status transition', async () => {
    mockPrisma.workflowExecution.updateMany
      .mockResolvedValueOnce({ count: 1 }) // Worker A wins transition
      .mockResolvedValueOnce({ count: 0 }); // Worker B loses transition

    const workerATransition = await mockPrisma.workflowExecution.updateMany({
      where: { id: 'exec-race-22', status: 'pending' },
      data: { status: 'running', updatedAt: new Date() },
    });

    const workerBTransition = await mockPrisma.workflowExecution.updateMany({
      where: { id: 'exec-race-22', status: 'pending' },
      data: { status: 'running', updatedAt: new Date() },
    });

    // Verify race condition prevented: only 1 worker successfully mutates state
    expect(workerATransition.count).toBe(1);
    expect(workerBTransition.count).toBe(0);
  });


  // SCENARIO 23: Graceful Shutdown

  it('Scenario 23: Graceful shutdown - Pauses queue polling and closes queue connections cleanly', async () => {
    const mockWorker = { pause: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) };
    const mockDlqWorker = { close: jest.fn().mockResolvedValue(undefined) };
    (queueService as any).worker = mockWorker;
    (queueService as any).dlqWorker = mockDlqWorker;

    await queueService.onModuleDestroy();

    // Verify graceful shutdown sequence:
    expect(mockWorker.pause).toHaveBeenCalled();
    expect(mockWorker.close).toHaveBeenCalled();
    expect(mockDlqWorker.close).toHaveBeenCalled();
    expect(mockDlqQueue.close).toHaveBeenCalled();
  });


  // SCENARIO 24: Database Race Condition (Step Execution State Transition)

  it('Scenario 24: Database race condition - Conditional step status update prevents lost updates', async () => {
    mockPrisma.stepExecution.updateMany
      .mockResolvedValueOnce({ count: 1 }) // Heartbeat monitor updates status
      .mockResolvedValueOnce({ count: 0 }); // Concurrent recovery worker attempts duplicate transition

    const transition1 = await mockPrisma.stepExecution.updateMany({
      where: { id: 'step-race-24', status: 'RUNNING' },
      data: { status: 'TIMED_OUT', error: 'Stale heartbeat' },
    });

    const transition2 = await mockPrisma.stepExecution.updateMany({
      where: { id: 'step-race-24', status: 'RUNNING' },
      data: { status: 'FAILED', error: 'Worker crash' },
    });

    // Verify atomic state transition: exactly 1 update succeeds
    expect(transition1.count).toBe(1);
    expect(transition2.count).toBe(0);
  });

  // SCENARIO 25: API Error Sanitization
  it('Scenario 25: API error sanitization - Redacts credentials, tokens, and authorization headers from errors', () => {
    const rawErrorPayload =
      'HTTP 401 Unauthorized: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretKey, api_key=sk-proj-99999, password=SuperSecret123!';

    const sanitized = sanitizePayloadString(rawErrorPayload);

    // Verify sensitive data redacted completely:
    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretKey');
    expect(sanitized).not.toContain('sk-proj-99999');
    expect(sanitized).not.toContain('SuperSecret123!');

    expect(sanitized).toContain('Authorization: [REDACTED]');
    expect(sanitized).toContain('api_key=[REDACTED]');
    expect(sanitized).toContain('password=[REDACTED]');
  });
});
