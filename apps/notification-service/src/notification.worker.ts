import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { StructuredLogger } from '@forgegate/logger';

@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private worker!: Worker;
  private logger = new StructuredLogger('notification-service');

  onModuleInit() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

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
        connection: { host: redisHost, port: redisPort },
        concurrency: 10,
      },
    );

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      if (job) {
        this.logger.error(`Notification job ${job.id} failed: ${err.message}`, err.stack);
      }
    });
  }

  onModuleDestroy() {
    if (this.worker) {
      this.worker.close();
    }
  }
}
