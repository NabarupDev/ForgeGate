import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { QueueService } from './queue.service';
import { WorkflowController } from './workflow.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
  ],
  controllers: [WorkflowController],
  providers: [PrismaService, WorkflowEngineService, QueueService],
  exports: [PrismaService, WorkflowEngineService, QueueService],
})
export class AppModule {}
