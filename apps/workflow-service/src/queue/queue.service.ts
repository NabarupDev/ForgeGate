import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { StructuredLogger } from '@forgegate/logger';
import { MetricsService } from '@forgegate/common';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { calculateRetryDecision } from '../workflow-engine/http-retry-scheduler';

export function sanitizePayloadString(str: string): string {
  if (!str) return str;
  return str
    .replace(/(authorization:\s*)(bearer\s+[^\s,]+|[^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)([a-zA-Z0-9._-]+)/gi, '[REDACTED]')
    .replace(/(api[-_]?key\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(password\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(secret\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]');
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private workflowQueue!: Queue;
  private dlqQueue!: Queue;
  private worker!: Worker;
  private dlqWorker!: Worker;
  private queueEvents!: QueueEvents;
  private structuredLogger = new StructuredLogger('workflow-queue');
  private metricsService = MetricsService.getInstance();

  constructor(private readonly engineService: WorkflowEngineService) {}

  async onModuleInit() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
    const connection = { host: redisHost, port: redisPort };

    this.workflowQueue = new Queue('workflow-executions', { connection });
    this.dlqQueue = new Queue('workflow-dlq', { connection });
    this.queueEvents = new QueueEvents('workflow-executions', { connection });

    // Main execution worker with intelligent retry scheduling
    this.worker = new Worker(
      'workflow-executions',
      async (job: Job) => {
        const { executionId, tenantId, correlationId } = job.data;
        const currentAttempt = job.data.normalAttempts ? job.data.normalAttempts : job.attemptsMade + 1;
        return this.engineService.executeExecution(executionId, tenantId, currentAttempt, correlationId);
      },
      {
        connection,
        concurrency: 5,
      },
    );

    this.worker.on('completed', (job) => {
      this.structuredLogger.logEvent('job_completed', {
        jobId: job.id,
        executionId: job.data.executionId,
        correlationId: job.data.correlationId,
      });
      this.updateQueueGauges();
    });

    this.worker.on('failed', async (job: Job | undefined, err: Error) => {
      if (!job) return;
      const { executionId, tenantId, rateLimitDeferrals = 0, normalAttempts = 1, correlationId } = job.data;

      let createdAt = new Date();
      try {
        const execution = await this.engineService.getExecutionById(executionId);
        if (execution?.startedAt) {
          createdAt = execution.startedAt;
        }
      } catch (e) {
        // Fallback to current time if lookup fails
      }

      const decision = calculateRetryDecision(err, normalAttempts, rateLimitDeferrals, createdAt);

      if (decision.shouldRetry) {
        this.metricsService.stepRetriesTotal.inc({ action_type: 'http_request' });

        this.structuredLogger.logEvent('job_retry_scheduled', {
          jobId: job.id,
          executionId,
          correlationId,
          delayMs: decision.delayMs,
          reason: decision.reason,
          isRateLimitDeferral: decision.isRateLimitDeferral,
          rateLimitDeferrals: decision.newRateLimitDeferralsCount,
          normalAttempts: decision.newNormalAttemptCount,
        });

        await this.workflowQueue.add(
          'execute-workflow',
          {
            executionId,
            tenantId,
            correlationId,
            rateLimitDeferrals: decision.newRateLimitDeferralsCount,
            normalAttempts: decision.newNormalAttemptCount,
          },
          {
            delay: decision.delayMs,
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
      } else {
        let workflowId = 'unknown';
        let failedStepId = (err as any).stepId || 'unknown';
        const category = (err as any).category || 'PERMANENT_FAILURE';
        const httpStatus = (err as any).statusCode || (err as any).status || null;

        try {
          const execution = await this.engineService.getExecutionById(executionId);
          if (execution && execution.workflowId) {
            workflowId = execution.workflowId;
          }
        } catch (e) {
          // Fallback
        }

        const sanitizedMessage = sanitizePayloadString(err.message || 'Workflow step failed');

        const dlqData = {
          originalJobId: job.id,
          executionId,
          tenantId,
          workflowId,
          failedStepId,
          failureCategory: category,
          httpStatus,
          retryCount: normalAttempts,
          rateLimitDeferralCount: rateLimitDeferrals,
          finalErrorMessage: sanitizedMessage,
          timestamp: new Date().toISOString(),
          lastAttemptTimestamp: new Date().toISOString(),
          correlationId: correlationId || `corr-${executionId}`,
          replayed: false,
          replayedAt: null,
          errorReason: `${sanitizedMessage} (${decision.reason})`,
        };

        this.structuredLogger.error(
          `Job ${job.id} will not be retried (${decision.reason}). Moving to DLQ.`,
          err.stack,
          { executionId, tenantId, correlationId, dlqData },
        );

        await this.dlqQueue.add('dead-letter-job', dlqData);
        await this.engineService.markAsFailed(executionId, `${sanitizedMessage} (${decision.reason})`);
      }

      this.updateQueueGauges();
    });

    // DLQ worker stub to process or hold dead letters
    this.dlqWorker = new Worker(
      'workflow-dlq',
      async (job: Job) => {
        this.structuredLogger.log(`DLQ Job registered: ${job.id}`, {
          executionId: job.data.executionId,
          correlationId: job.data.correlationId,
        });
        return { status: 'in_dlq', data: job.data };
      },
      { connection },
    );

    this.updateQueueGauges();
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.dlqWorker?.close();
    await this.workflowQueue?.close();
    await this.dlqQueue?.close();
    await this.queueEvents?.close();
  }

  private async updateQueueGauges() {
    try {
      if (!this.workflowQueue || !this.dlqQueue) return;
      const waitingJobs = await this.workflowQueue.getWaitingCount();
      const activeJobs = await this.workflowQueue.getActiveCount();
      const failedJobs = await this.workflowQueue.getFailedCount();
      const dlqJobs = await this.dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);

      this.metricsService.waitingJobsGauge.set(waitingJobs);
      this.metricsService.activeJobsGauge.set(activeJobs);
      this.metricsService.failedJobsGauge.set(failedJobs);
      this.metricsService.queueDepthGauge.set(waitingJobs + activeJobs);
      this.metricsService.dlqSizeGauge.set(dlqJobs.length);
    } catch {
      // Non-blocking gauge updates
    }
  }

  async enqueueWorkflowExecution(executionId: string, tenantId: string, correlationId?: string) {
    const effectiveCorrelationId = correlationId || `corr-${executionId}`;
    let jobId = `job-${executionId}`;

    if (this.workflowQueue && typeof this.workflowQueue.add === 'function') {
      const job = await this.workflowQueue.add(
        'execute-workflow',
        { executionId, tenantId, correlationId: effectiveCorrelationId, rateLimitDeferrals: 0, normalAttempts: 1 },
        {
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
      if (job) jobId = job.id;
    }

    this.structuredLogger.logEvent('job_enqueued', {
      jobId,
      executionId,
      tenantId,
      correlationId: effectiveCorrelationId,
    });

    this.updateQueueGauges();
    return { jobId };
  }

  /**
   * Scans for stale step executions across worker nodes and re-enqueues orphaned workflows.
   */
  async recoverStaleExecutions(leaseDurationMs: number = 30000) {
    const staleList = await this.engineService.findAndMarkStaleStepExecutions(leaseDurationMs);
    let reenqueuedCount = 0;
    const reenqueuedIds: string[] = [];

    for (const item of staleList) {
      const activeJobs =
        this.workflowQueue && typeof this.workflowQueue.getJobs === 'function'
          ? await this.workflowQueue.getJobs(['active', 'waiting', 'delayed'])
          : [];
      const alreadyQueued = activeJobs.some((j) => j.data.executionId === item.executionId);

      if (!alreadyQueued) {
        await this.enqueueWorkflowExecution(item.executionId, item.tenantId);
        reenqueuedCount++;
        reenqueuedIds.push(item.executionId);
      } else {
        this.structuredLogger.logEvent('stale_recovery_skipped_already_queued', {
          executionId: item.executionId,
        });
      }
    }

    return {
      staleCount: staleList.length,
      reenqueuedCount,
      reenqueuedIds,
    };
  }

  async addExecutionJob(executionId: string, tenantId: string, correlationId?: string) {
    const res = await this.enqueueWorkflowExecution(executionId, tenantId, correlationId);
    return { jobId: res.jobId, status: 'enqueued' };
  }

  async replayDlqJob(jobId: string, operatorId: string = 'operator') {
    if (!this.dlqQueue) {
      throw new Error(`DLQ Queue unavailable`);
    }

    const job = await this.dlqQueue.getJob(jobId);
    if (!job) {
      throw new Error(`DLQ Job ${jobId} not found`);
    }

    const { executionId, tenantId, replayed, correlationId } = job.data;

    // 1. Prevent duplicate replay if already replayed or currently active in queue
    const activeJobs =
      this.workflowQueue && typeof this.workflowQueue.getJobs === 'function'
        ? await this.workflowQueue.getJobs(['active', 'waiting', 'delayed'])
        : [];
    const isCurrentlyActive = activeJobs.some((j) => j.data?.executionId === executionId);
    if (isCurrentlyActive) {
      throw new Error(`Execution ${executionId} is currently running or queued for execution`);
    }

    if (replayed) {
      throw new Error(`DLQ Job ${jobId} (Execution ${executionId}) has already been replayed`);
    }

    // 2. Mark DLQ record as replayed for audit and UI transparency
    const updatedData = {
      ...job.data,
      replayed: true,
      replayedAt: new Date().toISOString(),
      replayedBy: operatorId,
    };
    if (typeof job.updateData === 'function') {
      await job.updateData(updatedData);
    } else {
      job.data = updatedData;
    }

    if (typeof job.remove === 'function') {
      await job.remove();
    }

    // 3. Preserve audit trail in WorkflowEngineService
    if (typeof this.engineService.logReplayEvent === 'function') {
      await this.engineService.logReplayEvent(executionId, tenantId, operatorId, job.id);
    }

    // 4. Enqueue execution with fresh attempt counter (preserving step execution history)
    const res = await this.enqueueWorkflowExecution(executionId, tenantId, correlationId);

    return {
      jobId: res.jobId,
      executionId,
      status: 'replayed',
      replayedAt: new Date().toISOString(),
    };
  }

  async getMetrics() {
    if (!this.workflowQueue || !this.dlqQueue) {
      return {
        activeJobs: 0,
        waitingJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        dlqCount: 0,
        totalQueueSize: 0,
      };
    }
    const waitingJobs = await this.workflowQueue.getWaitingCount();
    const activeJobs = await this.workflowQueue.getActiveCount();
    const completedJobs = await this.workflowQueue.getCompletedCount();
    const failedJobs = await this.workflowQueue.getFailedCount();
    const dlqJobs = await this.dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    return {
      activeJobs,
      waitingJobs,
      completedJobs,
      failedJobs,
      dlqCount: dlqJobs.length,
      totalQueueSize: activeJobs + waitingJobs,
    };
  }

  async getDlqJobs() {
    if (!this.dlqQueue) return [];
    const jobs = await this.dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    return jobs.map((job) => {
      const d = job.data || {};
      const isRateLimited = (d.rateLimitDeferralCount || 0) > 0 || d.failureCategory === 'RATE_LIMITED';
      const replayed = Boolean(d.replayed);

      return {
        jobId: job.id,
        id: job.id,
        executionId: d.executionId,
        tenantId: d.tenantId,
        workflowId: d.workflowId || 'unknown',
        failedStepId: d.failedStepId || 'unknown',
        failureCategory: d.failureCategory || 'PERMANENT_FAILURE',
        httpStatus: d.httpStatus ?? null,
        retryCount: d.retryCount || 1,
        rateLimitDeferralCount: d.rateLimitDeferralCount || 0,
        isRateLimited,
        finalErrorMessage: d.finalErrorMessage || d.errorReason || job.failedReason || 'Unknown error',
        failedReason: job.failedReason || d.finalErrorMessage || d.errorReason,
        timestamp: d.timestamp || new Date(job.timestamp).toISOString(),
        lastAttemptTimestamp: d.lastAttemptTimestamp || new Date(job.timestamp).toISOString(),
        correlationId: d.correlationId || d.executionId,
        replayed,
        replayedAt: d.replayedAt || null,
        retryableAt: replayed ? 'N/A' : 'Immediate upon replay',
      };
    });
  }

  async replayDeadLetterExecution(executionId: string, tenantId: string) {
    if (!this.dlqQueue) return this.enqueueWorkflowExecution(executionId, tenantId);
    const dlqJobs = await this.dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    const matchingJob = dlqJobs.find((j) => j.data.executionId === executionId && !j.data.replayed);
    if (matchingJob) {
      return this.replayDlqJob(matchingJob.id);
    }
    return this.enqueueWorkflowExecution(executionId, tenantId);
  }

  async getExecutionStatus(executionId: string) {
    if (!this.workflowQueue) return { status: 'not_found' };
    const jobs = await this.workflowQueue.getJobs(['active', 'waiting', 'completed', 'failed']);
    const job = jobs.find((j) => j.data.executionId === executionId);

    if (!job) {
      return { status: 'not_found' };
    }

    const state = await job.getState();
    return {
      jobId: job.id,
      status: state,
      progress: job.progress,
      failedReason: job.failedReason,
    };
  }
}
