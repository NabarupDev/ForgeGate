import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import Redis from 'ioredis';
import { WorkflowEngineService } from './workflow-engine.service';
import { StructuredLogger } from '@forgegate/logger';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private workflowQueue!: Queue;
  private dlqQueue!: Queue;
  private worker!: Worker;
  private dlqWorker!: Worker;
  private queueEvents!: QueueEvents;
  private structuredLogger = new StructuredLogger('workflow-queue');

  constructor(private readonly engineService: WorkflowEngineService) {}

  onModuleInit() {
    const connection = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
      : {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
        };

    this.workflowQueue = new Queue('workflow-executions', { connection });
    this.dlqQueue = new Queue('workflow-dlq', { connection });
    this.queueEvents = new QueueEvents('workflow-executions', { connection });

    // Main execution worker with exponential retries
    this.worker = new Worker(
      'workflow-executions',
      async (job: Job) => {
        const { executionId, tenantId } = job.data;
        return this.engineService.executeExecution(executionId, tenantId, job.attemptsMade + 1);
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
      const attemptsMade = job.attemptsMade;
      const maxAttempts = job.opts.attempts || 3;

      this.structuredLogger.warn(`Job ${job.id} failed attempt ${attemptsMade}/${maxAttempts}: ${err.message}`, {
        executionId: job.data.executionId,
        tenantId: job.data.tenantId,
      });

      if (attemptsMade >= maxAttempts) {
        this.structuredLogger.error(`Job ${job.id} exhausted retries. Moving to Dead Letter Queue (DLQ).`, err.stack, {
          executionId: job.data.executionId,
          tenantId: job.data.tenantId,
        });

        // Move to DLQ
        await this.dlqQueue.add('dead-letter-job', {
          originalJobId: job.id,
          executionId: job.data.executionId,
          tenantId: job.data.tenantId,
          failedAt: new Date().toISOString(),
          errorReason: err.message,
        });

        await this.engineService.markAsFailed(job.data.executionId, err.message);
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
    if (this.worker) await this.worker.close();
    if (this.dlqWorker) await this.dlqWorker.close();
    if (this.workflowQueue) await this.workflowQueue.close();
    if (this.dlqQueue) await this.dlqQueue.close();
  }

  async addExecutionJob(executionId: string, tenantId: string) {
    const job = await this.workflowQueue.add(
      'execute-workflow',
      { executionId, tenantId },
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

    return { jobId: job.id, status: 'enqueued' };
  }

  async getMetrics() {
    const dlqJobs = await this.dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    const [wWaiting, wActive, wCompleted, wFailed] = await Promise.all([
      this.workflowQueue.getWaitingCount(),
      this.workflowQueue.getActiveCount(),
      this.workflowQueue.getCompletedCount(),
      this.workflowQueue.getFailedCount(),
    ]);

    return {
      activeJobs: wActive,
      waitingJobs: wWaiting,
      completedJobs: wCompleted,
      failedJobs: wFailed,
      dlqCount: dlqJobs.length,
      totalQueueSize: wWaiting + wActive,
    };
  }

  async getDlqJobs() {
    const jobs = await this.dlqQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    return jobs.map((j) => ({
      id: j.id,
      data: j.data,
      timestamp: j.timestamp,
      failedReason: j.failedReason,
    }));
  }

  async replayDlqJob(jobId: string) {
    const job = await this.dlqQueue.getJob(jobId);
    if (!job) {
      throw new Error(`DLQ Job ${jobId} not found`);
    }

    const { executionId, tenantId } = job.data;
    await job.remove();

    return this.addExecutionJob(executionId, tenantId);
  }
}
