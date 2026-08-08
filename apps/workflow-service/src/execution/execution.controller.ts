import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { TriggerExecutionDto } from './dto/trigger-execution.dto';
import { JwtAuthGuard, CurrentUser, UserContext } from '@forgegate/auth';

@Controller('workflows')
@UseGuards(JwtAuthGuard)
export class ExecutionController {
  constructor(private readonly executionService: ExecutionService) {}

  @Get('executions/:id')
  async getExecution(@Param('id') id: string, @CurrentUser() user: UserContext) {
    return this.executionService.getExecution(id, user);
  }

  @Post(':id/trigger')
  async triggerWorkflow(
    @Param('id') id: string,
    @Body() dto: TriggerExecutionDto,
    @CurrentUser() user: UserContext,
  ) {
    return this.executionService.triggerWorkflow(id, dto, user);
  }
}
