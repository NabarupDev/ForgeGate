import { Controller, Get, Post, Param } from '@nestjs/common';
import { QueueService } from './queue.service';

@Controller('workflows')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get('metrics/queue')
  async getQueueMetrics() {
    return this.queueService.getMetrics();
  }

  @Get('dlq/jobs')
  async getDlqJobs() {
    return this.queueService.getDlqJobs();
  }

  @Post('dlq/:jobId/retry')
  async retryDlqJob(@Param('jobId') jobId: string) {
    return this.queueService.replayDlqJob(jobId);
  }
}
