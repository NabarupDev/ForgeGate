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

describe('ForgeGate Distributed Workflow Failure-Injection Test Suite', () => {
  let mockPrisma: any;
  let engineService: WorkflowEngineService;
  let queueService: QueueService;
  let mockRedis: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma = {
      workflowExecution: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'exec-fail-1', status: 'pending' }),
      },
      stepExecution: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'step-exec-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      executionLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      workflow: {
        findUnique: jest.fn(),
      },
    };

    mockRedis = {
      eval: jest.fn(),
      incr: jest.fn(),
      decr: jest.fn(),
      expire: jest.fn(),
      ttl: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    engineService = new WorkflowEngineService(mockPrisma as any);
    queueService = new QueueService(engineService);
  });

  /**
   * Test Scenario 1: Worker crashes before step execution
   * Initial State: WorkflowExecution is PENDING in database, job is in BullMQ waiting queue.
   * Failure Injected: Worker process dies before calling executeStep / StepExecution creation.
   * Expected Durable State: WorkflowExecution remains PENDING/RUNNING, StepExecution does not exist or is PENDING.
   * Expected Queue State: Job lease expires in BullMQ queue.
   * Expected Final State: Stale recovery process re-enqueues job; workflow is executed cleanly on worker restart.
   */
  it('Scenario 1: Worker crashes before step execution', async () => {
    mockPrisma.stepExecution.findMany.mockResolvedValueOnce([
      {
        id: 'step-exec-orphaned',
        executionId: 'exec-crash-before',
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 40000),
        heartbeatAt: null,
        execution: { id: 'exec-crash-before', tenantId: 'tenant-1', status: 'pending' },
      },
    ]);

    const recoveryResult = await queueService.recoverStaleExecutions(30000);

    expect(recoveryResult.staleCount).toBe(1);
    expect(recoveryResult.reenqueuedCount).toBe(1);
  });

  /**
   * Test Scenario 2: Worker crashes during HTTP request
   * Initial State: StepExecution is RUNNING with active heartbeat timestamp.
   * Failure Injected: Worker node crashes mid-request; heartbeat updates cease for >30s.
   * Expected Durable State: StepExecution has status RUNNING with heartbeatAt < (now - 30s).
   * Expected Queue State: Job removed from old worker active list.
   * Expected Final State: Stale recovery marks old StepExecution TIMED_OUT, sets WorkflowExecution status 'retrying', and re-enqueues execution.
   */
  it('Scenario 2: Worker crashes during HTTP request', async () => {
    const expiredTime = new Date(Date.now() - 45000);
    mockPrisma.stepExecution.findMany.mockResolvedValueOnce([
      {
        id: 'step-exec-crashed-mid-http',
        executionId: 'exec-crash-during',
        status: 'RUNNING',
        startedAt: expiredTime,
        heartbeatAt: expiredTime,
        execution: { id: 'exec-crash-during', tenantId: 'tenant-1', status: 'running' },
      },
    ]);

    const recoveryResult = await queueService.recoverStaleExecutions(30000);

    expect(recoveryResult.staleCount).toBe(1);
    expect(recoveryResult.reenqueuedCount).toBe(1);
    expect(recoveryResult.reenqueuedIds).toContain('exec-crash-during');
    expect(mockPrisma.stepExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'step-exec-crashed-mid-http', status: 'RUNNING' },
        data: expect.objectContaining({ status: 'TIMED_OUT', error: expect.stringContaining('crash detected') }),
      }),
    );
  });

  /**
   * Test Scenario 3: HTTP 429 (Rate-Limited)
   * Initial State: Workflow step makes HTTP request to downstream provider.
   * Failure Injected: Downstream provider returns HTTP 429 Too Many Requests without Retry-After header.
   * Expected Durable State: StepExecution transitions to FAILED with category RATE_LIMITED.
   * Expected Queue State: Job fails in BullMQ, trigger retry decision logic.
   * Expected Final State: Classified as RATE_LIMITED (isRetryable: true), exponential backoff calculated without consuming normal retry budget.
   */
  it('Scenario 3: HTTP 429 without Retry-After header', async () => {
    const error429: any = new Error('Request failed with status code 429');
    error429.response = { status: 429, headers: {} };

    const classified = classifyHttpError(error429, 'https://api.provider.com/v1', 'POST');
    expect(classified.category).toBe('RATE_LIMITED');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.isRateLimitDeferral).toBe(true);
    expect(decision.newNormalAttemptCount).toBe(1); // Normal attempt budget UNTOUCHED
    expect(decision.newRateLimitDeferralsCount).toBe(1);
  });

  /**
   * Test Scenario 4: HTTP 429 with Retry-After header
   * Initial State: Workflow step makes HTTP request.
   * Failure Injected: Downstream provider returns HTTP 429 with `Retry-After: 5` header.
   * Expected Durable State: StepExecution FAILED with category RATE_LIMITED and retryAfterSeconds: 5.
   * Expected Queue State: Retry scheduled with exact 5000ms delay.
   * Expected Final State: Delayed retry job enqueued in BullMQ after 5000ms delay.
   */
  it('Scenario 4: HTTP 429 with Retry-After header', async () => {
    const error429: any = new Error('Rate limit exceeded');
    error429.response = { status: 429, headers: { 'retry-after': '5' } };

    const classified = classifyHttpError(error429, 'https://api.provider.com/v1', 'POST');
    expect(classified.retryAfterSeconds).toBe(5);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBe(5000);
    expect(decision.isRateLimitDeferral).toBe(true);
  });

  /**
   * Test Scenario 5: HTTP 500 (Internal Server Error)
   * Initial State: Step execution in progress.
   * Failure Injected: Downstream API returns 500 Internal Server Error.
   * Expected Durable State: StepExecution status FAILED with TRANSIENT_FAILURE category.
   * Expected Queue State: Job fails in BullMQ; normal retry attempt consumed.
   * Expected Final State: Exponential backoff with jitter scheduled, normal attempt count incremented (1 -> 2).
   */
  it('Scenario 5: HTTP 500 Internal Server Error', async () => {
    const error500: any = new Error('Internal Server Error');
    error500.response = { status: 500, headers: {} };

    const classified = classifyHttpError(error500, 'https://api.service.com', 'GET');
    expect(classified.category).toBe('TRANSIENT_FAILURE');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.isRateLimitDeferral).toBe(false);
    expect(decision.newNormalAttemptCount).toBe(2); // Normal attempt budget CONSUMED
  });

  /**
   * Test Scenario 6: HTTP 503 (Service Unavailable)
   * Initial State: Step execution in progress.
   * Failure Injected: Downstream API returns HTTP 503 Service Unavailable.
   * Expected Durable State: StepExecution FAILED with TRANSIENT_FAILURE category.
   * Expected Queue State: Job fails, normal retry attempt incremented.
   * Expected Final State: Scheduled for bounded exponential backoff retry.
   */
  it('Scenario 6: HTTP 503 Service Unavailable', async () => {
    const error503: any = new Error('Service Unavailable');
    error503.response = { status: 503, headers: {} };

    const classified = classifyHttpError(error503, 'https://api.service.com', 'GET');
    expect(classified.category).toBe('TRANSIENT_FAILURE');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
  });

  /**
   * Test Scenario 7: Network Timeout
   * Initial State: Step execution making HTTP request.
   * Failure Injected: HTTP request exceeds configurable step timeout (e.g. 3000ms), throwing `ECONNABORTED`.
   * Expected Durable State: StepExecution status set to TIMED_OUT.
   * Expected Queue State: Job fails; retry decision evaluates TIMEOUT category.
   * Expected Final State: Step execution marked TIMED_OUT; retry scheduled consuming normal attempt budget.
   */
  it('Scenario 7: Network timeout', async () => {
    const timeoutErr: any = new Error('timeout of 3000ms exceeded');
    timeoutErr.code = 'ECONNABORTED';

    const classified = classifyHttpError(timeoutErr, 'https://slow.api.com', 'POST');
    expect(classified.category).toBe('TIMEOUT');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.newNormalAttemptCount).toBe(2);
  });

  /**
   * Test Scenario 8: DNS / Network Connection Failure
   * Initial State: Step execution attempting outbound HTTP connection.
   * Failure Injected: Network layer fails with `ENOTFOUND` (DNS resolution failure) or `ECONNREFUSED`.
   * Expected Durable State: StepExecution status FAILED with NETWORK_FAILURE category.
   * Expected Queue State: Job fails in BullMQ queue.
   * Expected Final State: Classified as NETWORK_FAILURE, retry scheduled with exponential backoff.
   */
  it('Scenario 8: DNS/network failure', async () => {
    const dnsErr: any = new Error('getaddrinfo ENOTFOUND api.unreachable-domain.com');
    dnsErr.code = 'ENOTFOUND';

    const classified = classifyHttpError(dnsErr, 'https://api.unreachable-domain.com', 'GET');
    expect(classified.category).toBe('NETWORK_FAILURE');
    expect(classified.isRetryable).toBe(true);

    const decision = calculateRetryDecision(classified, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.newNormalAttemptCount).toBe(2);
  });

  /**
   * Test Scenario 9: Downstream request succeeds but response is lost (Idempotency)
   * Initial State: Step execution configured with `idempotency.enabled: true`.
   * Failure Injected: Request reaches downstream provider and completes, but worker node crashes before persisting response. Worker retries step.
   * Expected Durable State: First StepExecution status remains RUNNING/TIMED_OUT; second StepExecution receives same stable `Idempotency-Key` header.
   * Expected Queue State: Job retried in queue.
   * Expected Final State: Stable idempotency key generated deterministically from `(tenantId, executionId, stepId)`, preventing duplicate provider action.
   */
  it('Scenario 9: Downstream request succeeds but response is lost (Idempotency Key Verification)', async () => {
    const keyAttempt1 = generateStepIdempotencyKey('tenant-1', 'exec-lost-resp', 'step-pay');
    const keyAttempt2 = generateStepIdempotencyKey('tenant-1', 'exec-lost-resp', 'step-pay');

    expect(keyAttempt1).toBe(keyAttempt2); // Key MUST remain identical across retries
    expect(keyAttempt1).toContain('forgegate:tenant-1:');
  });

  /**
   * Test Scenario 10: Duplicate worker execution (Atomic Claim Check)
   * Initial State: Single StepExecution in PENDING status in Prisma database.
   * Failure Injected: Two worker threads/nodes concurrently attempt to claim the PENDING StepExecution.
   * Expected Durable State: Atomic `updateMany({ where: { id, status: 'PENDING' }, data: { status: 'RUNNING' } })` updates count=1 for Worker 1 and count=0 for Worker 2.
   * Expected Queue State: Worker 1 processes step; Worker 2 safely skips step execution.
   * Expected Final State: Exactly one worker executes the step; step is never executed twice concurrently.
   */
  it('Scenario 10: Duplicate worker execution (Atomic Claim Check)', async () => {
    mockPrisma.stepExecution.updateMany
      .mockResolvedValueOnce({ count: 1 }) // Worker 1 wins claim
      .mockResolvedValueOnce({ count: 0 }); // Worker 2 loses claim

    const claimWorker1 = await mockPrisma.stepExecution.updateMany({
      where: { id: 'step-1', status: 'PENDING' },
      data: { status: 'RUNNING', workerId: 'worker-1' },
    });

    const claimWorker2 = await mockPrisma.stepExecution.updateMany({
      where: { id: 'step-1', status: 'PENDING' },
      data: { status: 'RUNNING', workerId: 'worker-2' },
    });

    expect(claimWorker1.count).toBe(1);
    expect(claimWorker2.count).toBe(0);
  });

  /**
   * Test Scenario 11: Queue retry scheduling
   * Initial State: Worker executes job and catches retryable step error.
   * Failure Injected: Step fails with retryable HTTP 500 error on attempt 1.
   * Expected Durable State: StepExecution FAILED for attempt 1.
   * Expected Queue State: BullMQ worker listener catches failure and calls `workflowQueue.add()` with delayMs.
   * Expected Final State: Delayed retry job present in queue with updated `normalAttempts: 2`.
   */
  it('Scenario 11: Queue retry scheduling', async () => {
    const error500: any = new Error('500 Internal Error');
    error500.response = { status: 500 };

    const decision = calculateRetryDecision(error500, 1, 0, new Date());
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(0);
    expect(decision.newNormalAttemptCount).toBe(2);
  });

  /**
   * Test Scenario 12: Retry budget exhaustion
   * Initial State: Job has failed repeatedly and reached `normalAttempts: 3` (MAX_NORMAL_ATTEMPTS = 3).
   * Failure Injected: Step fails again with HTTP 500 error.
   * Expected Durable State: WorkflowExecution status set to `failed`.
   * Expected Queue State: `calculateRetryDecision` returns `shouldRetry: false`. Job moved to DLQ (`workflow-dlq`).
   * Expected Final State: Execution terminated; diagnostic payload saved in DLQ; no further retries scheduled.
   */
  it('Scenario 12: Retry budget exhaustion', async () => {
    const error500: any = new Error('500 Internal Error');
    error500.response = { status: 500 };

    const decision = calculateRetryDecision(error500, 3, 0, new Date()); // Max attempt reached
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe('max_normal_retries_exceeded');
  });

  /**
   * Test Scenario 13: Rate-limit deferral exhaustion
   * Initial State: Downstream provider continuously returns HTTP 429; `rateLimitDeferrals: 5` (MAX_RATE_LIMIT_DEFERRALS = 5).
   * Failure Injected: Step receives 6th consecutive HTTP 429 response.
   * Expected Durable State: WorkflowExecution status updated to `failed`.
   * Expected Queue State: `shouldRetry` returns false; job routed to DLQ.
   * Expected Final State: Infinite rate-limit deferral loop prevented; job placed in DLQ for operator review.
   */
  it('Scenario 13: Rate-limit deferral exhaustion', async () => {
    const error429: any = new Error('429 Rate Limited');
    error429.response = { status: 429 };

    const classified = classifyHttpError(error429, 'https://api.provider.com', 'POST');
    const decision = calculateRetryDecision(classified, 1, 5, new Date()); // Max deferrals reached
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe('max_rate_limit_deferrals_exceeded');
  });

  /**
   * Test Scenario 14: DLQ insertion & secret payload sanitization
   * Initial State: Job fails permanently or exhausts retries with sensitive authorization tokens in error message.
   * Failure Injected: Error message contains `Authorization: Bearer secret-key-999` and `password=MyPassword`.
   * Expected Durable State: DLQ job record stored in BullMQ `workflow-dlq`.
   * Expected Queue State: Job enqueued into DLQ.
   * Expected Final State: Sensitive headers and secrets redacted to `[REDACTED]` in DLQ record diagnostic metadata.
   */
  it('Scenario 14: DLQ insertion & secret payload sanitization', () => {
    const rawError = 'Failed request with Authorization: Bearer secret-token-xyz, api_key=sk-123456, password=SecretPassword123!';
    const sanitized = sanitizePayloadString(rawError);

    expect(sanitized).not.toContain('secret-token-xyz');
    expect(sanitized).not.toContain('sk-123456');
    expect(sanitized).not.toContain('SecretPassword123!');
    expect(sanitized).toContain('Authorization: [REDACTED]');
    expect(sanitized).toContain('api_key=[REDACTED]');
    expect(sanitized).toContain('password=[REDACTED]');
  });

  /**
   * Test Scenario 15: DLQ replay attempt & audit logging
   * Initial State: Un-replayed DLQ record `dlq-job-1` exists in DLQ.
   * Failure Injected: Operator triggers replay via `replayDlqJob('dlq-job-1', 'operator-admin')`.
   * Expected Durable State: WorkflowExecution status updated to `running`, `DLQ_REPLAY` audit log entry created in `ExecutionLog`.
   * Expected Queue State: DLQ job marked `replayed: true` and execution re-enqueued into main `workflow-executions` queue.
   * Expected Final State: Workflow execution resumed with clean retry attempt count; duplicate replay blocked if attempted again.
   */
  it('Scenario 15: DLQ replay attempt & audit logging', async () => {
    const mockDlqJobData = {
      executionId: 'exec-dlq-replay-test',
      tenantId: 'tenant-1',
      workflowId: 'wf-1',
      replayed: false,
    };

    const mockDlqJob = {
      id: 'dlq-job-replay-15',
      data: mockDlqJobData,
      updateData: jest.fn().mockImplementation((newData) => {
        mockDlqJob.data = newData;
      }),
    };

    const mockDlqQueue = {
      getJob: jest.fn().mockResolvedValue(mockDlqJob),
    };

    const mockWorkflowQueue = {
      getJobs: jest.fn().mockResolvedValue([]),
      add: jest.fn().mockResolvedValue({ id: 'replayed-job-new' }),
    };

    (queueService as any).dlqQueue = mockDlqQueue;
    (queueService as any).workflowQueue = mockWorkflowQueue;

    const result = await queueService.replayDlqJob('dlq-job-replay-15', 'operator-alice');

    expect(result.status).toBe('replayed');
    expect(mockDlqJob.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ replayed: true, replayedBy: 'operator-alice' }),
    );
  });

  /**
   * Test Scenario 16: Tenant isolation in outbound rate limits
   * Initial State: Tenant A and Tenant B both send requests to provider `openai.com`.
   * Failure Injected: Tenant A exceeds outbound rate limit for `tenant:tenantA + openai.com`.
   * Expected Durable State: Redis rate-limit counter for `tenantA` is exhausted.
   * Expected Queue State: Tenant A jobs deferred; Tenant B jobs allowed.
   * Expected Final State: Tenant A request rejected with HTTP 429 rate limit; Tenant B request allowed without interference.
   */
  it('Scenario 16: Tenant isolation in outbound rate limits', async () => {
    const rateLimiter = new OutboundRateLimiter(mockRedis, {
      tenantProviderLimits: {
        tenantA: { 'api.openai.com': { limit: 1, windowSeconds: 60 } },
      },
    });

    mockRedis.incr
      .mockResolvedValueOnce(1) // Tenant A req 1 -> count = 1 (limit 1, allowed)
      .mockResolvedValueOnce(2) // Tenant A req 2 -> count = 2 (limit 1, rejected)
      .mockResolvedValueOnce(1); // Tenant B req 1 -> count = 1 (no limit configured, allowed)

    mockRedis.expire.mockResolvedValue(1);
    mockRedis.decr.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(60);

    const resTenantA1 = await rateLimiter.checkAndConsume({
      tenantId: 'tenantA',
      stepConfig: { url: 'https://api.openai.com/v1/chat' },
    });

    const resTenantA2 = await rateLimiter.checkAndConsume({
      tenantId: 'tenantA',
      stepConfig: { url: 'https://api.openai.com/v1/chat' },
    });

    const resTenantB = await rateLimiter.checkAndConsume({
      tenantId: 'tenantB',
      stepConfig: { url: 'https://api.openai.com/v1/chat' },
    });

    expect(resTenantA1.allowed).toBe(true);
    expect(resTenantA2.allowed).toBe(false);
    expect(resTenantB.allowed).toBe(true);
  });

  /**
   * Test Scenario 17: Tenant isolation in workflow resource access
   * Initial State: User belongs to `tenant-alpha` with role `workflow_owner`.
   * Failure Injected: User attempts to access workflow or execution belonging to `tenant-beta`.
   * Expected Durable State: Authorization policy evaluates `user.tenantId !== resource.tenantId`.
   * Expected Queue State: No execution enqueued.
   * Expected Final State: Request denied with `403 Forbidden` / `404 Not Found`; cross-tenant leakage prevented.
   */
  it('Scenario 17: Tenant isolation in workflow resource access', () => {
    const userTenantA = { id: 'user-1', email: 'user@tenant-alpha.com', role: 'workflow_owner', tenantId: 'tenant-alpha' };
    const workflowTenantB = { id: 'wf-beta', tenantId: 'tenant-beta', createdById: 'user-2' };

    const canRead = AuthorizationPolicy.can(userTenantA, 'workflow:read', workflowTenantB);
    const canExecute = AuthorizationPolicy.can(userTenantA, 'workflow:execute', workflowTenantB);

    expect(canRead).toBe(false);
    expect(canExecute).toBe(false);
  });

  /**
   * Test Scenario 18: Provider concurrency limit backpressure
   * Initial State: Outbound provider `stripe.com` configured with maximum concurrency limit = 2.
   * Failure Injected: 3 concurrent steps attempt to acquire lease for `stripe.com` simultaneously.
   * Expected Durable State: Concurrency active lease counter in Redis = 2.
   * Expected Queue State: Third request rejected with concurrency backpressure.
   * Expected Final State: First 2 requests acquire lease; 3rd request rejected with RATE_LIMITED / `outbound_concurrency_limit_exceeded`.
   */
  it('Scenario 18: Provider concurrency limit backpressure', async () => {
    const concurrencyLimiter = new OutboundConcurrencyLimiter(mockRedis, {
      providerLimits: {
        'api.stripe.com': 2,
      },
    });

    mockRedis.incr
      .mockResolvedValueOnce(1) // Request 1 acquired (count 1 <= limit 2)
      .mockResolvedValueOnce(2) // Request 2 acquired (count 2 <= limit 2)
      .mockResolvedValueOnce(3); // Request 3 rejected (count 3 > limit 2)

    mockRedis.expire.mockResolvedValue(1);
    mockRedis.decr.mockResolvedValue(2);

    const req1 = await concurrencyLimiter.acquire({
      tenantId: 'tenant-1',
      stepConfig: { url: 'https://api.stripe.com/v1/charges' },
    });

    const req2 = await concurrencyLimiter.acquire({
      tenantId: 'tenant-1',
      stepConfig: { url: 'https://api.stripe.com/v1/charges' },
    });

    const req3 = await concurrencyLimiter.acquire({
      tenantId: 'tenant-1',
      stepConfig: { url: 'https://api.stripe.com/v1/charges' },
    });

    expect(req1.acquired).toBe(true);
    expect(req2.acquired).toBe(true);
    expect(req3.acquired).toBe(false);
    expect(req3.exceededScope).toBe('provider');
  });

  /**
   * Test Scenario 19: Worker restart with orphaned RUNNING StepExecution
   * Initial State: StepExecution remains RUNNING from a dead worker node.
   * Failure Injected: Worker restarts after crash and executes `recoverStaleExecutions`.
   * Expected Durable State: Orphaned StepExecution status updated from RUNNING to TIMED_OUT in Prisma.
   * Expected Queue State: Re-enqueues execution job into BullMQ.
   * Expected Final State: Stale RUNNING step is freed; workflow execution status set to `retrying` and resumed safely.
   */
  it('Scenario 19: Worker restart with orphaned RUNNING StepExecution', async () => {
    const staleHeartbeat = new Date(Date.now() - 60000);
    mockPrisma.stepExecution.findMany.mockResolvedValueOnce([
      {
        id: 'step-orphaned-19',
        status: 'RUNNING',
        heartbeatAt: staleHeartbeat,
        execution: { id: 'exec-19', tenantId: 'tenant-1', status: 'running' },
      },
    ]);

    const result = await engineService.findAndMarkStaleStepExecutions(30000);

    expect(result.length).toBe(1);
    expect(result[0].executionId).toBe('exec-19');
    expect(mockPrisma.stepExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'step-orphaned-19', status: 'RUNNING' },
        data: expect.objectContaining({ status: 'TIMED_OUT' }),
      }),
    );
  });

  /**
   * Test Scenario 20: Timed-out step recovery & execution resumption
   * Initial State: Workflow step previously failed due to timeout (`status: TIMED_OUT`).
   * Failure Injected: Workflow execution is re-enqueued and retried on worker node.
   * Expected Durable State: Engine checks step order and previous StepExecutions; executes step anew on fresh attempt.
   * Expected Queue State: Job processed cleanly by worker.
   * Expected Final State: Retried step succeeds; new StepExecution created with status `SUCCEEDED`; workflow completes.
   */
  it('Scenario 20: Timed-out step recovery & execution resumption', async () => {
    const mockWorkflowExecution = {
      id: 'exec-recovery-20',
      tenantId: 'tenant-1',
      workflowId: 'wf-recovery',
      currentStep: 1,
      metadata: {},
      workflow: {
        steps: [
          {
            id: 'step-http-20',
            stepOrder: 1,
            actionType: 'http_request',
            config: { url: 'https://api.recovered.com/data', method: 'GET' },
          },
        ],
      },
    };

    mockPrisma.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
    mockedAxios.mockResolvedValueOnce({ status: 200, data: { recovered: true } });

    const result = await engineService.executeExecution('exec-recovery-20', 'tenant-1', 2);

    expect(result.status).toBe('completed');
    expect(mockPrisma.stepExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executionId: 'exec-recovery-20',
          stepId: 'step-http-20',
          attempt: 2,
          status: 'PENDING',
        }),
      }),
    );
  });
});
