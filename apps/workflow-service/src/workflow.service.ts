import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { QueueService } from './queue.service';

export interface CreateWorkflowDto {
  name: string;
  description?: string;
  triggerType?: string;
  createdById: string;
  tenantId: string;
  steps?: Array<{
    stepOrder?: number;
    actionType?: string;
    config?: any;
    retryLimit?: number;
  }>;
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async createWorkflow(dto: CreateWorkflowDto) {
    const { name, description, triggerType, createdById, tenantId, steps } = dto;
    if (!name || !tenantId || !createdById) {
      throw new BadRequestException('name, tenantId, and createdById are required');
    }

    return this.prisma.workflow.create({
      data: {
        name,
        description,
        triggerType: triggerType || 'webhook',
        createdById,
        tenantId,
        steps: {
          create: (steps || []).map((s: any, idx: number) => ({
            stepOrder: s.stepOrder || idx + 1,
            actionType: s.actionType || 'http_request',
            config: s.config || {},
            retryLimit: s.retryLimit || 3,
          })),
        },
      },
      include: { steps: true },
    });
  }

  async getWorkflows(tenantId?: string) {
    const where = tenantId ? { tenantId } : {};
    return this.prisma.workflow.findMany({
      where,
      include: { steps: true, _count: { select: { executions: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getWorkflowById(id: string) {
    const wf = await this.prisma.workflow.findUnique({
      where: { id },
      include: { steps: true, executions: { take: 10, orderBy: { startedAt: 'desc' } } },
    });
    if (!wf) throw new NotFoundException('Workflow not found');
    return wf;
  }

  async triggerWorkflow(id: string, payload: { tenantId?: string; metadata?: any }) {
    const wf = await this.prisma.workflow.findUnique({ where: { id } });
    if (!wf) throw new NotFoundException('Workflow not found');

    const tenantId = payload.tenantId || wf.tenantId;

    const execution = await this.prisma.workflowExecution.create({
      data: {
        workflowId: wf.id,
        tenantId,
        status: 'pending',
        metadata: payload.metadata || {},
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

  async getQueueMetrics() {
    return this.queueService.getMetrics();
  }

  async getDlqJobs() {
    return this.queueService.getDlqJobs();
  }

  async replayDlqJob(jobId: string) {
    return this.queueService.replayDlqJob(jobId);
  }
}
