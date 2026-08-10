import { Controller, Post, Get, Body, Param, Headers, UseGuards } from '@nestjs/common';
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
