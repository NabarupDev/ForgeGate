import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { StructuredLogger } from '@forgegate/logger';

@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private worker!: Worker;
  private logger = new StructuredLogger('notification-service');

  onModuleInit() {
    const connection = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
      : {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
        };

    this.worker = new Worker(
      'notification-events',
      async (job: Job) => {
        const { recipient, subject, payload, tenantId } = job.data;
        this.logger.logEvent('notification_sending', {
          jobId: job.id,
          recipient,
          subject,
          tenantId,
        });

        // Simulate notification dispatch with brief delay
        await new Promise((resolve) => setTimeout(resolve, 300));

        this.logger.logEvent('notification_delivered', {
          jobId: job.id,
          recipient,
          status: 'SENT',
        });

        return { status: 'DELIVERED', recipient, deliveredAt: new Date().toISOString() };
      },
      {
        connection,
        concurrency: 10,
      },
    );

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      if (job) {
        this.logger.error(`Notification job ${job.id} failed: ${err.message}`, err.stack);
      }
    });
  }

  async onModuleDestroy() {
    this.logger.log('[Shutdown Stage 1/2] Pausing and closing Notification BullMQ worker...');
    if (this.worker) {
      try {
        await this.worker.pause(true);
        await this.worker.close();
      } catch (e) {
        // Teardown fallback
      }
    }
    this.logger.log('[Shutdown Stage 2/2] NotificationWorker graceful shutdown complete.');
  }
}
