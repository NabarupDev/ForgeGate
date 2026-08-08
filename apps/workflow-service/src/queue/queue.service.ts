import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { StructuredLogger } from '@forgegate/logger';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { calculateRetryDecision } from '../workflow-engine/http-retry-scheduler';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private workflowQueue!: Queue;
  private dlqQueue!: Queue;
  private worker!: Worker;
  private dlqWorker!: Worker;
  private queueEvents!: QueueEvents;
  private structuredLogger = new StructuredLogger('workflow-queue');

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
        const { executionId, tenantId } = job.data;
        const currentAttempt = job.data.normalAttempts ? job.data.normalAttempts : job.attemptsMade + 1;
        return this.engineService.executeExecution(executionId, tenantId, currentAttempt);
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
      });
    });

    this.worker.on('failed', async (job: Job | undefined, err: Error) => {
      if (!job) return;
      const { executionId, tenantId, rateLimitDeferrals = 0, normalAttempts = 1 } = job.data;

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
        this.structuredLogger.logEvent('job_retry_scheduled', {
          jobId: job.id,
          executionId,
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
        this.structuredLogger.error(
          `Job ${job.id} will not be retried (${decision.reason}). Moving to DLQ.`,
          err.stack,
          { executionId, tenantId },
        );

        await this.dlqQueue.add('dead-letter-job', {
          originalJobId: job.id,
          executionId,
          tenantId,
          failedAt: new Date().toISOString(),
          errorReason: `${err.message} (${decision.reason})`,
        });

        await this.engineService.markAsFailed(executionId, `${err.message} (${decision.reason})`);
      }
    });

    // DLQ worker stub to process or hold dead letters
    this.dlqWorker = new Worker(
      'workflow-dlq',
      async (job: Job) => {
        this.structuredLogger.log(`DLQ Job registered: ${job.id}`, { executionId: job.data.executionId });
        return { status: 'in_dlq', data: job.data };
      },
      { connection },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.dlqWorker?.close();
    await this.workflowQueue?.close();
    await this.dlqQueue?.close();
    await this.queueEvents?.close();
  }

  async enqueueWorkflowExecution(executionId: string, tenantId: string) {
    const job = await this.workflowQueue.add(
      'execute-workflow',
      { executionId, tenantId, rateLimitDeferrals: 0, normalAttempts: 1 },
      {
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    this.structuredLogger.logEvent('job_enqueued', {
      jobId: job.id,
      executionId,
      tenantId,
    });

    return { jobId: job.id };
  }

  /**
   * Scans for stale step executions across worker nodes and re-enqueues orphaned workflows.
   */
  async recoverStaleExecutions(leaseDurationMs: number = 30000) {
    const staleList = await this.engineService.findAndMarkStaleStepExecutions(leaseDurationMs);
    let reenqueuedCount = 0;
    const reenqueuedIds: string[] = [];

    for (const item of staleList) {
      const activeJobs = await this.workflowQueue.getJobs(['active', 'waiting', 'delayed']);
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

  async addExecutionJob(executionId: string, tenantId: string) {
    const res = await this.enqueueWorkflowExecution(executionId, tenantId);
    return { jobId: res.jobId, status: 'enqueued' };
  }

  async replayDlqJob(jobId: string) {
    const job = await this.dlqQueue.getJob(jobId);
    if (!job) {
      throw new Error(`DLQ Job ${jobId} not found`);
    }
    await job.remove();
    const res = await this.enqueueWorkflowExecution(job.data.executionId, job.data.tenantId);
    return { jobId: res.jobId, status: 'enqueued' };
  }

  async getMetrics() {
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
    const jobs = await this.dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    return jobs.map((job) => ({
      jobId: job.id,
      data: job.data,
      failedReason: job.failedReason,
      timestamp: job.timestamp,
    }));
  }

  async replayDeadLetterExecution(executionId: string, tenantId: string) {
    return this.enqueueWorkflowExecution(executionId, tenantId);
  }

  async getExecutionStatus(executionId: string) {
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
