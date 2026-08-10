import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';

import { WorkflowController } from './workflow/workflow.controller';
import { WorkflowService } from './workflow/workflow.service';

import { ExecutionController } from './execution/execution.controller';
import { ExecutionService } from './execution/execution.service';
import { ApiIdempotencyService } from './execution/api-idempotency.service';

import { QueueController } from './queue/queue.controller';
import { QueueService } from './queue/queue.service';

import { WorkflowEngineService } from './workflow-engine/workflow-engine.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
  ],
  controllers: [WorkflowController, ExecutionController, QueueController],
  providers: [
    PrismaService,
    WorkflowService,
    ExecutionService,
    ApiIdempotencyService,
    QueueService,
    WorkflowEngineService,
  ],
  exports: [
    PrismaService,
    WorkflowService,
    ExecutionService,
    ApiIdempotencyService,
    QueueService,
    WorkflowEngineService,
  ],
})
export class AppModule {}
