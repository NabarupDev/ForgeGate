import { Controller, Post, Get, Body, Param, Query } from '@nestjs/common';
import { WorkflowService, CreateWorkflowDto } from './workflow.service';

@Controller('workflows')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get('health')
  health() {
    return { service: 'workflow-service', status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('metrics/queue')
  async getQueueMetrics() {
    return this.workflowService.getQueueMetrics();
  }

  @Get('dlq/jobs')
  async getDlqJobs() {
    return this.workflowService.getDlqJobs();
  }

  @Post('dlq/:jobId/retry')
  async retryDlqJob(@Param('jobId') jobId: string) {
    return this.workflowService.replayDlqJob(jobId);
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string) {
    return this.workflowService.getExecution(id);
  }

  @Post()
  async createWorkflow(@Body() dto: CreateWorkflowDto) {
    return this.workflowService.createWorkflow(dto);
  }

  @Get()
  async getWorkflows(@Query('tenantId') tenantId: string) {
    return this.workflowService.getWorkflows(tenantId);
  }

  @Get(':id')
  async getWorkflow(@Param('id') id: string) {
    return this.workflowService.getWorkflowById(id);
  }

  @Post(':id/trigger')
  async triggerWorkflow(@Param('id') id: string, @Body() body: { tenantId?: string; metadata?: any }) {
    return this.workflowService.triggerWorkflow(id, body);
  }
}
