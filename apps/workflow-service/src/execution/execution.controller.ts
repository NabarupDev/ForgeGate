import { Controller, Post, Get, Body, Param, Query, Headers, UseGuards } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { TriggerExecutionDto } from './dto/trigger-execution.dto';
import { JwtAuthGuard, CurrentUser, UserContext } from '@forgegate/auth';

@Controller('workflows')
@UseGuards(JwtAuthGuard)
export class ExecutionController {
  constructor(private readonly executionService: ExecutionService) {}

  @Get('executions')
  async getExecutions(
    @CurrentUser() user: UserContext,
    @Query('workflowId') workflowId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.executionService.getExecutions(
      user,
      { workflowId, status },
      { limit, skip, cursor },
    );
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string, @CurrentUser() user: UserContext) {
    return this.executionService.getExecution(id, user);
  }

  @Get('executions/:id/logs')
  async getExecutionLogs(
    @Param('id') id: string,
    @CurrentUser() user: UserContext,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.executionService.getExecutionLogs(id, user, { limit, skip, cursor });
  }

  @Post(':id/trigger')
  async triggerWorkflow(
    @Param('id') id: string,
    @Body() dto: TriggerExecutionDto,
    @Headers('x-correlation-id') correlationHeader: string,
    @Headers('idempotency-key') idempotencyHeader: string,
    @Headers('x-idempotency-key') xIdempotencyHeader: string,
    @CurrentUser() user: UserContext,
  ) {
    const correlationId =
      correlationHeader ||
      dto.metadata?.correlationId ||
      `corr-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const idempotencyKey = idempotencyHeader || xIdempotencyHeader;

    return this.executionService.triggerWorkflow(
      id,
      { ...dto, metadata: { ...dto.metadata, correlationId } },
      user,
      idempotencyKey,
    );
  }
}
