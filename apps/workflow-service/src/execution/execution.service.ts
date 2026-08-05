import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { QueueService } from '../queue/queue.service';
import { TriggerExecutionDto } from './dto/trigger-execution.dto';

@Injectable()
export class ExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async triggerWorkflow(id: string, dto: TriggerExecutionDto) {
    const wf = await this.prisma.workflow.findUnique({ where: { id } });
    if (!wf) throw new NotFoundException('Workflow not found');

    const tenantId = dto.tenantId || wf.tenantId;

    const execution = await this.prisma.workflowExecution.create({
      data: {
        workflowId: wf.id,
        tenantId,
        status: 'pending',
        metadata: dto.metadata || {},
      },
    });

    const queueResult = await this.queueService.addExecutionJob(execution.id, tenantId);

    return {
      executionId: execution.id,
      status: execution.status,
      queue: queueResult,
    };
  }

  async getExecution(id: string) {
    const execution = await this.prisma.workflowExecution.findUnique({
      where: { id },
      include: { workflow: true, logs: { orderBy: { createdAt: 'asc' } } },
    });
    if (!execution) throw new NotFoundException('Execution not found');
    return execution;
  }
}
