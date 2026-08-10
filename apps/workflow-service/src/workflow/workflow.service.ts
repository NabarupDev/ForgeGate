import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UserContext, AuthorizationPolicy } from '@forgegate/auth';
import { parsePaginationParams, buildPaginatedResult, PaginationQuery, PaginatedResult } from '@forgegate/common';

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  async createWorkflow(dto: CreateWorkflowDto, user?: UserContext) {
    if (user && !AuthorizationPolicy.can(user, 'workflow:create')) {
      throw new ForbiddenException(`Role '${user.role}' is not authorized to create workflows`);
    }

    const { name, description, triggerType, createdById, tenantId, steps } = dto;
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const effectiveTenantId = user?.tenantId || tenantId;
    const effectiveCreatedById = user?.id || createdById;

    if (!effectiveTenantId || !effectiveCreatedById) {
      throw new BadRequestException('name, tenantId, and createdById are required');
    }

    return this.prisma.workflow.create({
      data: {
        name,
        description,
        triggerType: triggerType || 'webhook',
        createdById: effectiveCreatedById,
        tenantId: effectiveTenantId,
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

  async getWorkflows(
    userOrTenantId?: UserContext | string,
    query?: PaginationQuery,
  ): Promise<PaginatedResult<any>> {
    let tenantId: string | undefined;
    let userCtx: UserContext | undefined;

    if (typeof userOrTenantId === 'string') {
      tenantId = userOrTenantId;
    } else if (userOrTenantId) {
      userCtx = userOrTenantId;
      tenantId = userCtx.tenantId;
    }

    if (userCtx && !AuthorizationPolicy.can(userCtx, 'workflow:read')) {
      throw new ForbiddenException(`Role '${userCtx.role}' is not authorized to read workflows`);
    }

    const { limit, skip, cursor } = parsePaginationParams(query);
    const where: any = tenantId ? { tenantId } : {};

    const totalCount = await this.prisma.workflow.count({ where });

    const queryArgs: any = {
      where,
      take: limit + 1,
      include: { steps: true, _count: { select: { executions: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    };

    if (cursor) {
      queryArgs.cursor = { id: cursor };
      queryArgs.skip = 1;
    } else if (skip) {
      queryArgs.skip = skip;
    }

    const items = await this.prisma.workflow.findMany(queryArgs);
    return buildPaginatedResult(items, limit, (item) => item.id, totalCount, skip);
  }

  async getWorkflowById(id: string, user?: UserContext) {
    if (user && !AuthorizationPolicy.can(user, 'workflow:read')) {
      throw new ForbiddenException(`Role '${user.role}' is not authorized to read workflows`);
    }

    let wf: any = null;
    if (user && typeof this.prisma.workflow.findFirst === 'function') {
      wf = await this.prisma.workflow.findFirst({
        where: { id, tenantId: user.tenantId },
        include: { steps: true, executions: { take: 10, orderBy: { startedAt: 'desc' } } },
      });
    } else {
      wf = await this.prisma.workflow.findUnique({
        where: { id },
        include: { steps: true, executions: { take: 10, orderBy: { startedAt: 'desc' } } },
      });
    }

    if (!wf) throw new NotFoundException('Workflow not found');

    if (user && (wf.tenantId !== user.tenantId || !AuthorizationPolicy.can(user, 'workflow:read', wf))) {
      throw new NotFoundException('Workflow not found');
    }

    return wf;
  }

  async updateWorkflow(id: string, dto: Partial<CreateWorkflowDto>, user?: UserContext) {
    const wf = await this.getWorkflowById(id, user);

    if (user && !AuthorizationPolicy.can(user, 'workflow:update', wf)) {
      throw new ForbiddenException('You do not have permission to modify this workflow');
    }

    return this.prisma.workflow.update({
      where: { id: wf.id },
      data: {
        name: dto.name ?? wf.name,
        description: dto.description ?? wf.description,
        triggerType: dto.triggerType ?? wf.triggerType,
      },
      include: { steps: true },
    });
  }

  async deleteWorkflow(id: string, user?: UserContext) {
    const wf = await this.getWorkflowById(id, user);

    if (user && !AuthorizationPolicy.can(user, 'workflow:delete', wf)) {
      throw new ForbiddenException('You do not have permission to delete this workflow');
    }

    await this.prisma.workflow.delete({ where: { id: wf.id } });
    return { status: 'deleted', id };
  }
}
