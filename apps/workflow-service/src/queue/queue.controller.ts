import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { QueueService } from './queue.service';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, UserContext } from '@forgegate/auth';

@Controller('workflows')
@UseGuards(JwtAuthGuard, RolesGuard)
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get('metrics/queue')
  @Roles('admin', 'operator')
  async getQueueMetrics() {
    return this.queueService.getMetrics();
  }

  @Get('dlq/jobs')
  @Roles('admin', 'operator')
  async getDlqJobs(@CurrentUser() user: UserContext) {
    const tenantId = user?.role === 'admin' ? undefined : user?.tenantId;
    return this.queueService.getDlqJobs(tenantId);
  }

  @Post('dlq/:jobId/retry')
  @Roles('admin', 'operator')
  async retryDlqJob(@Param('jobId') jobId: string, @CurrentUser() user: UserContext) {
    const operatorId = user?.id || user?.email || 'operator';
    const requestTenantId = user?.role === 'admin' ? undefined : user?.tenantId;
    return this.queueService.replayDlqJob(jobId, operatorId, requestTenantId);
  }
}
