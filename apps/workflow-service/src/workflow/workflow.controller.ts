import { Controller, Post, Get, Body, Param, Query } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';

@Controller('workflows')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get('health')
  health() {
    return { service: 'workflow-service', status: 'ok', timestamp: new Date().toISOString() };
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
}
