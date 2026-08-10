import { Injectable, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { QueueService } from '../queue/queue.service';
import { TriggerExecutionDto } from './dto/trigger-execution.dto';
import { UserContext, AuthorizationPolicy } from '@forgegate/auth';
import { ApiIdempotencyService } from './api-idempotency.service';
import { parsePaginationParams, buildPaginatedResult, PaginationQuery, PaginatedResult } from '@forgegate/common';

@Injectable()
export class ExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    @Optional() private readonly idempotencyService?: ApiIdempotencyService,
  ) {}

  async triggerWorkflow(
    id: string,
    dto: TriggerExecutionDto,
    user?: UserContext,
    idempotencyKey?: string,
  ) {
    const targetTenantId = user?.tenantId || dto.tenantId || 'default';
    const operationScope = `trigger:${id}`;

    const executeOperation = async () => {
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
    };

    if (this.idempotencyService && idempotencyKey) {
      return this.idempotencyService.processIdempotentOperation(
        targetTenantId,
        operationScope,
        idempotencyKey,
        executeOperation,
      );
    }

    return executeOperation();
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

  async getExecutions(
    user?: UserContext,
    filter?: { workflowId?: string; status?: string },
    pagination?: PaginationQuery,
  ): Promise<PaginatedResult<any>> {
    const tenantId = user?.tenantId;
    if (user && !AuthorizationPolicy.can(user, 'execution:read')) {
      throw new ForbiddenException(`Role '${user.role}' is not authorized to read executions`);
    }

    const { limit, skip, cursor } = parsePaginationParams(pagination);
    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (filter?.workflowId) where.workflowId = filter.workflowId;
    if (filter?.status) where.status = filter.status;

    const totalCount = await this.prisma.workflowExecution.count({ where });

    const queryArgs: any = {
      where,
      take: limit + 1,
      include: { workflow: { select: { id: true, name: true } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    };

    if (cursor) {
      queryArgs.cursor = { id: cursor };
      queryArgs.skip = 1;
    } else if (skip) {
      queryArgs.skip = skip;
    }

    const items = await this.prisma.workflowExecution.findMany(queryArgs);
    return buildPaginatedResult(items, limit, (item) => item.id, totalCount, skip);
  }

  async getExecutionLogs(
    executionId: string,
    user?: UserContext,
    pagination?: PaginationQuery,
  ): Promise<PaginatedResult<any>> {
    const execution = await this.getExecution(executionId, user);
    const { limit, skip, cursor } = parsePaginationParams(pagination);

    const where = { executionId: execution.id };
    const totalCount = await this.prisma.executionLog.count({ where });

    const queryArgs: any = {
      where,
      take: limit + 1,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    };

    if (cursor) {
      queryArgs.cursor = { id: cursor };
      queryArgs.skip = 1;
    } else if (skip) {
      queryArgs.skip = skip;
    }

    const items = await this.prisma.executionLog.findMany(queryArgs);
    return buildPaginatedResult(items, limit, (item) => item.id, totalCount, skip);
  }
}
