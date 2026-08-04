import { Controller, Post, Get, Body, Param, Query, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { QueueService } from './queue.service';

@Controller('workflows')
export class WorkflowController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  @Post()
  async createWorkflow(@Body() body: any) {
    const { name, description, triggerType, createdById, tenantId, steps } = body;
    if (!name || !tenantId || !createdById) {
      throw new BadRequestException('name, tenantId, and createdById are required');
    }

    const workflow = await this.prisma.workflow.create({
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

    return workflow;
  }

  @Get()
  async getWorkflows(@Query('tenantId') tenantId: string) {
    const where = tenantId ? { tenantId } : {};
    return this.prisma.workflow.findMany({
      where,
      include: { steps: true, _count: { select: { executions: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get(':id')
  async getWorkflow(@Param('id') id: string) {
    const wf = await this.prisma.workflow.findUnique({
      where: { id },
      include: { steps: true, executions: { take: 10, orderBy: { startedAt: 'desc' } } },
    });
    if (!wf) throw new NotFoundException('Workflow not found');
    return wf;
  }

  @Post(':id/trigger')
  async triggerWorkflow(@Param('id') id: string, @Body() body: { tenantId?: string; metadata?: any }) {
    const wf = await this.prisma.workflow.findUnique({ where: { id } });
    if (!wf) throw new NotFoundException('Workflow not found');

    const tenantId = body.tenantId || wf.tenantId;

    const execution = await this.prisma.workflowExecution.create({
      data: {
        workflowId: wf.id,
        tenantId,
        status: 'pending',
        metadata: body.metadata || {},
      },
    });

    const queueResult = await this.queueService.addExecutionJob(execution.id, tenantId);

    return {
      executionId: execution.id,
      status: execution.status,
      queue: queueResult,
    };
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string) {
    const execution = await this.prisma.workflowExecution.findUnique({
      where: { id },
      include: { workflow: true, logs: { orderBy: { createdAt: 'asc' } } },
    });
    if (!execution) throw new NotFoundException('Execution not found');
    return execution;
  }

  @Get('metrics/queue')
  async getQueueMetrics() {
    return this.queueService.getMetrics();
  }

  @Get('dlq/jobs')
  async getDlqJobs() {
    return this.queueService.getDlqJobs();
  }

  @Post('dlq/:jobId/retry')
  async retryDlqJob(@Param('jobId') jobId: string) {
    return this.queueService.replayDlqJob(jobId);
  }

  @Get('health')
  health() {
    return { service: 'workflow-service', status: 'ok', timestamp: new Date().toISOString() };
  }
}
