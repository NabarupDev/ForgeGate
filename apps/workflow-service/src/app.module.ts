import { Module, Controller, Post, Get, Param, Body } from '@nestjs/common';

@Controller('workflows')
export class WorkflowController {
  @Post()
  createWorkflow(@Body() dto: any) {
    return { id: 'wf-123456', name: dto.name, status: 'active', stepsCount: dto.steps?.length || 0 };
  }

  @Post(':id/execute')
  triggerExecution(@Param('id') id: string) {
    return { executionId: 'exec-987654', workflowId: id, status: 'queued', retryPolicy: 'backoff_exponential' };
  }

  @Get('health')
  health() {
    return { service: 'workflow-service', engine: 'BullMQ/Redis', status: 'ok' };
  }
}

@Module({
  controllers: [WorkflowController],
})
export class AppModule {}
