import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

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
}
