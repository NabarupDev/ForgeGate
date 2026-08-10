import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StructuredLogger } from '@forgegate/logger';
import { MetricsService } from '@forgegate/common';
import axios from 'axios';
import { classifyHttpError, HttpStepError } from './http-step-classifier';
import { resolveHttpTimeout } from './http-timeout-resolver';
import { generateStepIdempotencyKey } from './idempotency';
import { OutboundRateLimiter } from './outbound-rate-limiter';
import { OutboundConcurrencyLimiter, ConcurrencyLease } from './outbound-concurrency-limiter';

function sanitizePayload(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizePayload);

  const sensitiveKeys = [
    'authorization',
    'auth',
    'cookie',
    'x-api-key',
    'apikey',
    'token',
    'secret',
    'password',
    'bearer',
    'private_key',
    'access_token',
  ];
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(data)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizePayload(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

@Injectable()
export class WorkflowEngineService {
  private structuredLogger = new StructuredLogger('workflow-engine');
  private metricsService = MetricsService.getInstance();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outboundRateLimiter?: OutboundRateLimiter,
    private readonly outboundConcurrencyLimiter?: OutboundConcurrencyLimiter,
  ) {}

  async executeExecution(
    executionId: string,
    tenantId: string,
    attemptCount: number = 1,
    correlationId?: string,
  ): Promise<any> {
    const startTime = Date.now();
    const workerId = process.env.HOSTNAME || `worker-${process.pid}`;

    const execution = await this.prisma.workflowExecution.findFirst({
      where: { id: executionId, tenantId },
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

    if (!execution) {
      throw new Error(`Workflow execution ${executionId} not found for tenant ${tenantId}`);
    }

    const effectiveCorrelationId =
      correlationId ||
      (execution.metadata as any)?.correlationId ||
      `corr-${executionId}`;

    // Metric: Workflow execution started
    this.metricsService.workflowExecutionsTotal.inc({ status: 'started' });

    // State transition to 'running' or 'retrying'
    const statusState = attemptCount > 1 ? 'retrying' : 'running';
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: { status: statusState },
    });

    this.structuredLogger.logEvent('workflow_execution_started', {
      tenantId,
      workflowId: execution.workflowId,
      executionId: execution.id,
      correlationId: effectiveCorrelationId,
      attemptCount,
      workerId,
    });

    const steps = execution.workflow.steps;
    let stepPayloadInput = execution.metadata || {};

    try {
      for (const step of steps) {
        if (step.stepOrder < execution.currentStep) {
          continue; // Skip steps prior to current sequence
        }

        // Check if step has ALREADY SUCCEEDED in durable storage (idempotency check)
        const existingSucceededExec = await this.prisma.stepExecution.findFirst({
          where: {
            executionId: execution.id,
            stepId: step.id,
            status: 'SUCCEEDED',
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingSucceededExec) {
          this.structuredLogger.logEvent('step_already_completed_skipping', {
            executionId: execution.id,
            stepId: step.id,
            correlationId: effectiveCorrelationId,
            stepOrder: step.stepOrder,
          });

          const cachedOutput = existingSucceededExec.output;
          const currentPayload =
            stepPayloadInput && typeof stepPayloadInput === 'object'
              ? (stepPayloadInput as Record<string, any>)
              : {};
          stepPayloadInput = { ...currentPayload, [`step_${step.stepOrder}`]: cachedOutput };
          continue;
        }

        await this.prisma.workflowExecution.update({
          where: { id: executionId },
          data: { currentStep: step.stepOrder },
        });

        // Metric: Step execution started
        this.metricsService.stepExecutionsTotal.inc({ action_type: step.actionType, status: 'started' });

        // 1. Create StepExecution in PENDING state
        const stepExec = await this.prisma.stepExecution.create({
          data: {
            executionId: execution.id,
            stepId: step.id,
            attempt: attemptCount,
            status: 'PENDING',
            input: sanitizePayload(stepPayloadInput) as any,
            workerId,
          },
        });

        // 2. Atomic claim: transition StepExecution PENDING -> RUNNING
        const claimResult = await this.prisma.stepExecution.updateMany({
          where: {
            id: stepExec.id,
            status: 'PENDING',
          },
          data: {
            status: 'RUNNING',
            workerId,
            startedAt: new Date(),
            heartbeatAt: new Date(),
          },
        });

        if (claimResult.count === 0) {
          this.structuredLogger.warn(`Could not claim step ${step.id} for execution ${execution.id}`, {
            executionId: execution.id,
            stepId: step.id,
            correlationId: effectiveCorrelationId,
          });
          continue;
        }

        // Start active heartbeat timer (updates heartbeatAt every 5 seconds)
        const heartbeatTimer = setInterval(async () => {
          try {
            await this.prisma.stepExecution.updateMany({
              where: { id: stepExec.id, status: 'RUNNING', workerId },
              data: { heartbeatAt: new Date() },
            });
          } catch (hbErr) {
            // Silence transient heartbeat updates
          }
        }, 5000);

        let stepResult: any;
        try {
          stepResult = await this.executeStep(step, stepPayloadInput, {
            tenantId: execution.tenantId,
            executionId: execution.id,
            stepId: step.id,
            correlationId: effectiveCorrelationId,
          });

          // 3. Transition StepExecution RUNNING -> SUCCEEDED
          await this.prisma.stepExecution.update({
            where: { id: stepExec.id },
            data: {
              status: 'SUCCEEDED',
              finishedAt: new Date(),
              output: sanitizePayload(stepResult) as any,
            },
          });

          // Metric: Step succeeded
          this.metricsService.stepExecutionsTotal.inc({ action_type: step.actionType, status: 'succeeded' });
        } catch (stepErr: any) {
          const isHttpErr = stepErr instanceof HttpStepError;
          const isTimeout =
            stepErr.category === 'TIMEOUT' ||
            stepErr.subReason === 'request_timeout' ||
            stepErr.subReason === 'socket_timeout' ||
            stepErr.code === 'ECONNABORTED' ||
            stepErr.code === 'ETIMEDOUT';

          const endStatus = isTimeout ? 'TIMED_OUT' : 'FAILED';

          // Metric: Step failed / timed out
          this.metricsService.stepExecutionsTotal.inc({
            action_type: step.actionType,
            status: isTimeout ? 'timed_out' : 'failed',
          });

          if (isTimeout) {
            this.metricsService.stepTimeoutsTotal.inc({ action_type: step.actionType });
          }

          // Transition StepExecution RUNNING -> FAILED / TIMED_OUT
          await this.prisma.stepExecution.update({
            where: { id: stepExec.id },
            data: {
              status: endStatus,
              finishedAt: new Date(),
              error: stepErr.message || 'Unknown step execution error',
              output: isHttpErr ? (stepErr.toJSON() as any) : undefined,
            },
          });

          throw stepErr;
        } finally {
          clearInterval(heartbeatTimer);
        }

        // Maintain backward compatibility with ExecutionLog table
        await this.prisma.executionLog.create({
          data: {
            executionId: execution.id,
            stepId: step.id,
            status: 'completed',
            output: stepResult as any,
          },
        });

        const currentPayload =
          stepPayloadInput && typeof stepPayloadInput === 'object'
            ? (stepPayloadInput as Record<string, any>)
            : {};
        stepPayloadInput = { ...currentPayload, [`step_${step.stepOrder}`]: stepResult };
      }

      // Transition execution to 'completed'
      const durationMs = Date.now() - startTime;
      await this.prisma.workflowExecution.update({
        where: { id: executionId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          metadata: stepPayloadInput as any,
        },
      });

      // Metrics: Workflow succeeded
      this.metricsService.workflowExecutionsTotal.inc({ status: 'succeeded' });
      this.metricsService.workflowDuration.observe({ status: 'succeeded' }, durationMs / 1000);

      this.structuredLogger.logEvent('workflow_execution_completed', {
        tenantId,
        workflowId: execution.workflowId,
        executionId: execution.id,
        correlationId: effectiveCorrelationId,
        durationMs,
      });

      return { status: 'completed', durationMs };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const isTimeout = error.category === 'TIMEOUT';
      const endStatus = isTimeout ? 'timed_out' : 'failed';

      await this.prisma.executionLog.create({
        data: {
          executionId: execution.id,
          status: 'failed',
          error: error.message || 'Unknown step execution error',
        },
      });

      // Metrics: Workflow failed / timed out
      this.metricsService.workflowExecutionsTotal.inc({ status: endStatus });
      this.metricsService.workflowDuration.observe({ status: endStatus }, durationMs / 1000);

      this.structuredLogger.error('Workflow step execution failed', error.stack, {
        tenantId,
        workflowId: execution.workflowId,
        executionId: execution.id,
        correlationId: effectiveCorrelationId,
        durationMs,
      });

      throw error;
    }
  }

  /**
   * Identifies RUNNING step executions that haven't updated heartbeat within leaseDurationMs,
   * updates old worker's StepExecution to TIMED_OUT, and returns executions needing recovery.
   */
  async findAndMarkStaleStepExecutions(
    leaseDurationMs: number = 30000,
  ): Promise<Array<{ executionId: string; tenantId: string }>> {
    const cutoffTime = new Date(Date.now() - leaseDurationMs);

    const staleSteps = await this.prisma.stepExecution.findMany({
      where: {
        status: 'RUNNING',
        OR: [
          { heartbeatAt: { lt: cutoffTime } },
          { heartbeatAt: null, startedAt: { lt: cutoffTime } },
        ],
      },
      include: {
        execution: true,
      },
    });

    const recoveredMap = new Map<string, { executionId: string; tenantId: string }>();

    for (const stepExec of staleSteps) {
      // Mark old worker's StepExecution as TIMED_OUT
      const updated = await this.prisma.stepExecution.updateMany({
        where: {
          id: stepExec.id,
          status: 'RUNNING',
        },
        data: {
          status: 'TIMED_OUT',
          finishedAt: new Date(),
          error: 'Worker lease expired (crash detected)',
        },
      });

      if (updated.count > 0 && stepExec.execution) {
        if (stepExec.execution.status === 'running') {
          await this.prisma.workflowExecution.update({
            where: { id: stepExec.execution.id },
            data: { status: 'retrying' },
          });
        }

        recoveredMap.set(stepExec.execution.id, {
          executionId: stepExec.execution.id,
          tenantId: stepExec.execution.tenantId,
        });
      }
    }

    return Array.from(recoveredMap.values());
  }

  async logReplayEvent(
    executionId: string,
    tenantId: string,
    operatorId: string = 'operator',
    dlqJobId?: string,
  ) {
    const execution = await this.prisma.workflowExecution.findFirst({
      where: { id: executionId, tenantId },
    });

    if (execution) {
      const currentMetadata = (execution.metadata as Record<string, any>) || {};
      const replayCount = (currentMetadata.replayCount || 0) + 1;

      await this.prisma.workflowExecution.update({
        where: { id: executionId },
        data: {
          status: 'running',
          metadata: {
            ...currentMetadata,
            replayCount,
            lastReplayedAt: new Date().toISOString(),
            lastReplayedBy: operatorId,
            replayedFromDlqJobId: dlqJobId,
          },
        },
      });

      await this.prisma.executionLog.create({
        data: {
          executionId,
          stepId: 'DLQ_REPLAY',
          status: 'replay_triggered',
          output: {
            operatorId,
            dlqJobId,
            replayCount,
            timestamp: new Date().toISOString(),
          },
        },
      });
    }
  }

  private async executeStep(
    step: any,
    input: any,
    context?: { tenantId: string; executionId: string; stepId: string; correlationId?: string },
  ): Promise<any> {
    const config = step.config || {};

    switch (step.actionType) {
      case 'http_request': {
        const url = config.url || 'https://httpbin.org/get';
        const method = (config.method || 'GET').toUpperCase();
        const headers = { ...(config.headers || {}) };
        const body = config.body || input;

        // Low-cardinality provider hostname for metrics
        let providerHost = 'unknown';
        try {
          providerHost = new URL(url).hostname;
        } catch {
          // Fallback
        }

        // Attach x-correlation-id to outbound HTTP header for end-to-end tracing
        if (context?.correlationId) {
          headers['x-correlation-id'] = context.correlationId;
        }

        const idempotencyConfig = config.idempotency || {};
        const isIdempotencyEnabled =
          idempotencyConfig.enabled === true || Boolean(config.idempotencyKeyHeader);
        const headerName =
          idempotencyConfig.headerName || config.idempotencyKeyHeader || 'Idempotency-Key';

        if (isIdempotencyEnabled && context) {
          const idempotencyKey = generateStepIdempotencyKey(
            context.tenantId,
            context.executionId,
            context.stepId,
          );
          headers[headerName] = idempotencyKey;
        }

        let timeoutMs: number;
        try {
          timeoutMs = resolveHttpTimeout(config.timeoutMs);
        } catch (err: any) {
          throw new HttpStepError({
            category: 'PERMANENT_FAILURE',
            isRetryable: false,
            message: err.message,
            subReason: 'invalid_timeout_configuration',
            url,
            method,
          });
        }

        if (this.outboundRateLimiter) {
          const checkResult = await this.outboundRateLimiter.checkAndConsume({
            tenantId: context?.tenantId || 'default',
            workflowId: context?.executionId,
            stepId: context?.stepId,
            stepConfig: config,
          });

          if (!checkResult.allowed) {
            // Metrics: Backpressure rate limit rejection & deferral
            this.metricsService.backpressureRejectionsTotal.inc({ type: 'rate_limit' });
            this.metricsService.backpressureDeferredJobsTotal.inc({ reason: 'rate_limit' });
            this.metricsService.outboundHttpRateLimitDeferralsTotal.inc({ provider: providerHost });
            this.metricsService.outboundHttpRateLimitLimitedTotal.inc({
              provider: providerHost,
              scope: checkResult.exceededScope || 'unknown',
            });

            throw new HttpStepError({
              category: 'RATE_LIMITED',
              isRetryable: true,
              retryAfterSeconds: checkResult.retryAfterSeconds || 60,
              message: `Outbound rate limit exceeded for scope '${checkResult.exceededScope}'. Retry after ${checkResult.retryAfterSeconds} seconds.`,
              subReason: 'outbound_rate_limit_exceeded',
              url,
              method,
            });
          }

          this.metricsService.outboundHttpRateLimitAllowedTotal.inc({ provider: providerHost });
        }

        let concurrencyLease: ConcurrencyLease | undefined;
        if (this.outboundConcurrencyLimiter) {
          const concResult = await this.outboundConcurrencyLimiter.acquire({
            tenantId: context?.tenantId || 'default',
            workflowId: context?.executionId,
            stepId: context?.stepId,
            stepConfig: config,
          });

          if (!concResult.acquired) {
            // Metrics: Backpressure concurrency rejection & deferral
            this.metricsService.backpressureRejectionsTotal.inc({ type: 'concurrency' });
            this.metricsService.backpressureDeferredJobsTotal.inc({ reason: 'concurrency' });

            throw new HttpStepError({
              category: 'RATE_LIMITED',
              isRetryable: true,
              retryAfterSeconds: concResult.retryAfterSeconds || 2,
              message: `Outbound concurrency limit exceeded for scope '${concResult.exceededScope}'.`,
              subReason: 'outbound_concurrency_limit_exceeded',
              url,
              method,
            });
          }
          concurrencyLease = concResult.lease;
        }

        const httpStartTime = Date.now();
        try {
          const response = await axios({
            url,
            method,
            headers,
            data: method !== 'GET' ? body : undefined,
            timeout: timeoutMs,
          });

          const httpDurationMs = Date.now() - httpStartTime;
          this.metricsService.outboundHttpRequestsTotal.inc({
            provider: providerHost,
            status_code: String(response.status),
          });
          this.metricsService.outboundHttpRequestDuration.observe({ provider: providerHost }, httpDurationMs / 1000);

          return { statusCode: response.status, data: response.data };
        } catch (err: any) {
          const httpDurationMs = Date.now() - httpStartTime;
          const classifiedErr = classifyHttpError(err, url, method);

          const statusCode = String(classifiedErr.statusCode || (err.response?.status) || 500);
          this.metricsService.outboundHttpRequestsTotal.inc({ provider: providerHost, status_code: statusCode });
          this.metricsService.outboundHttpRequestDuration.observe({ provider: providerHost }, httpDurationMs / 1000);
          this.metricsService.outboundHttpFailuresTotal.inc({ provider: providerHost, category: classifiedErr.category });

          if (classifiedErr.category === 'RATE_LIMITED') {
            this.metricsService.outboundHttpRateLimitDeferralsTotal.inc({ provider: providerHost });
          }
          if (classifiedErr.category === 'TIMEOUT') {
            this.metricsService.outboundHttpTimeoutsTotal.inc({ provider: providerHost });
          }

          throw classifiedErr;
        } finally {
          if (this.outboundConcurrencyLimiter && concurrencyLease) {
            await this.outboundConcurrencyLimiter.release(concurrencyLease);
          }
        }
      }

      case 'data_transform': {
        const mapping = config.mapping || {};
        const transformed: Record<string, any> = {};
        for (const [key, val] of Object.entries(mapping)) {
          transformed[key] = val;
        }
        return { transformed: true, output: transformed };
      }

      case 'email_notification': {
        const recipient = config.recipient || 'user@example.com';
        const subject = config.subject || 'Workflow Notification';
        return { queuedNotification: true, recipient, subject, sentAt: new Date().toISOString() };
      }

      default:
        return { executed: true, stepType: step.actionType, timestamp: new Date().toISOString() };
    }
  }

  async markAsFailed(executionId: string, errorReason: string) {
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        status: 'failed',
        completedAt: new Date(),
      },
    });

    await this.prisma.executionLog.create({
      data: {
        executionId,
        status: 'failed_dead_letter',
        error: errorReason,
      },
    });
  }

  async getExecutionById(executionId: string) {
    return this.prisma.workflowExecution.findUnique({
      where: { id: executionId },
    });
  }
}
