import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UserContext, AuthorizationPolicy } from '@forgegate/auth';
import { parsePaginationParams, buildPaginatedResult, PaginationQuery, PaginatedResult, sanitizeAuditMetadata } from '@forgegate/common';

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  async recordAuditLog(params: {
    tenantId?: string | null;
    userId?: string | null;
    action: string;
    correlationId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, any> | null;
  }) {
    if (!this.prisma || !this.prisma.auditLog) {
      return null;
    }
    const sanitized = sanitizeAuditMetadata(params.metadata);
    return this.prisma.auditLog.create({
      data: {
        tenantId: params.tenantId || null,
        userId: params.userId || null,
        action: params.action,
        correlationId: params.correlationId || null,
        ipAddress: params.ipAddress || null,
        userAgent: params.userAgent || null,
        metadata: sanitized as any,
      },
    });
  }

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

    const created = await this.prisma.workflow.create({
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

    await this.recordAuditLog({
      tenantId: effectiveTenantId,
      userId: effectiveCreatedById,
      action: 'workflow.created',
      metadata: { workflowId: created.id, name: created.name, triggerType: created.triggerType },
    });

    return created;
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

    const updated = await this.prisma.workflow.update({
      where: { id: wf.id },
      data: {
        name: dto.name ?? wf.name,
        description: dto.description ?? wf.description,
        triggerType: dto.triggerType ?? wf.triggerType,
      },
      include: { steps: true },
    });

    await this.recordAuditLog({
      tenantId: wf.tenantId,
      userId: user?.id || wf.createdById,
      action: 'workflow.updated',
      metadata: { workflowId: wf.id, updatedFields: dto },
    });

    return updated;
  }

  async deleteWorkflow(id: string, user?: UserContext) {
    const wf = await this.getWorkflowById(id, user);

    if (user && !AuthorizationPolicy.can(user, 'workflow:delete', wf)) {
      throw new ForbiddenException('You do not have permission to delete this workflow');
    }

    await this.prisma.workflow.delete({ where: { id: wf.id } });

    await this.recordAuditLog({
      tenantId: wf.tenantId,
      userId: user?.id || wf.createdById,
      action: 'workflow.deleted',
      metadata: { workflowId: id },
    });

    return { status: 'deleted', id };
  }

  async getAuditLogs(userCtx?: UserContext, query?: PaginationQuery): Promise<PaginatedResult<any>> {
    if (userCtx && !AuthorizationPolicy.can(userCtx, 'workflow:read')) {
      throw new ForbiddenException(`Role '${userCtx.role}' is not authorized to read audit logs`);
    }

    const tenantId = userCtx?.tenantId;
    const { limit, skip, cursor } = parsePaginationParams(query);
    const where: any = tenantId ? { tenantId } : {};

    const totalCount = await this.prisma.auditLog.count({ where });

    const queryArgs: any = {
      where,
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    };

    if (cursor) {
      queryArgs.cursor = { id: cursor };
      queryArgs.skip = 1;
    } else if (skip) {
      queryArgs.skip = skip;
    }

    const items = await this.prisma.auditLog.findMany(queryArgs);
    return buildPaginatedResult(items, limit, (item) => item.id, totalCount, skip);
  }
}
