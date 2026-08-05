import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { TriggerExecutionDto } from './dto/trigger-execution.dto';

@Controller('workflows')
export class ExecutionController {
  constructor(private readonly executionService: ExecutionService) {}

  @Get('executions/:id')
  async getExecution(@Param('id') id: string) {
    return this.executionService.getExecution(id);
  }

  @Post(':id/trigger')
  async triggerWorkflow(@Param('id') id: string, @Body() dto: TriggerExecutionDto) {
    return this.executionService.triggerWorkflow(id, dto);
  }
}
