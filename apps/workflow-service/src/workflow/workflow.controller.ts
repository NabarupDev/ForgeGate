import { Controller, Post, Get, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { JwtAuthGuard, CurrentUser, UserContext } from '@forgegate/auth';

@Controller('workflows')
@UseGuards(JwtAuthGuard)
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get('health')
  health() {
    return { service: 'workflow-service', status: 'ok', timestamp: new Date().toISOString() };
  }

  @Post()
  async createWorkflow(@Body() dto: CreateWorkflowDto, @CurrentUser() user: UserContext) {
    return this.workflowService.createWorkflow(dto, user);
  }

  @Get()
  async getWorkflows(@CurrentUser() user: UserContext) {
    return this.workflowService.getWorkflows(user);
  }

  @Get(':id')
  async getWorkflow(@Param('id') id: string, @CurrentUser() user: UserContext) {
    return this.workflowService.getWorkflowById(id, user);
  }

  @Put(':id')
  async updateWorkflow(
    @Param('id') id: string,
    @Body() dto: Partial<CreateWorkflowDto>,
    @CurrentUser() user: UserContext,
  ) {
    return this.workflowService.updateWorkflow(id, dto, user);
  }

  @Delete(':id')
  async deleteWorkflow(@Param('id') id: string, @CurrentUser() user: UserContext) {
    return this.workflowService.deleteWorkflow(id, user);
  }
}
