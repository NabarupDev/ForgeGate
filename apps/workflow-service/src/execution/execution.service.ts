import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { QueueService } from '../queue/queue.service';
import { TriggerExecutionDto } from './dto/trigger-execution.dto';
import { UserContext, AuthorizationPolicy } from '@forgegate/auth';

@Injectable()
export class ExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async triggerWorkflow(id: string, dto: TriggerExecutionDto, user?: UserContext) {
    const targetTenantId = user?.tenantId || dto.tenantId;

    // 1. Enforce tenant isolation lookup when user/tenant context is provided
    let wf: any = null;
    if (typeof this.prisma.workflow.findFirst === 'function' && targetTenantId) {
      wf = await this.prisma.workflow.findFirst({
        where: { id, tenantId: targetTenantId },
      });
    } else {
      wf = await this.prisma.workflow.findUnique({ where: { id } });
    }

    if (!wf) throw new NotFoundException('Workflow not found');

    // 2. Server-side policy authorization check if user context exists
    if (user && !AuthorizationPolicy.can(user, 'workflow:execute', wf)) {
      throw new ForbiddenException(`Role '${user.role}' is not authorized to trigger workflow execution`);
    }

    const tenantId = user?.tenantId || dto.tenantId || wf.tenantId;

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

  async getExecution(id: string, user?: UserContext) {
    const execution = await this.prisma.workflowExecution.findUnique({
      where: { id },
      include: { workflow: true, logs: { orderBy: { createdAt: 'asc' } } },
    });

    if (!execution) throw new NotFoundException('Execution not found');

    // 3. Tenant Isolation & Policy Authorization Check when user context is present
    if (user && (execution.tenantId !== user.tenantId || !AuthorizationPolicy.can(user, 'execution:read', execution))) {
      throw new NotFoundException('Execution not found');
    }

    return execution;
  }
}
