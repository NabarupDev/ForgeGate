import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StructuredLogger } from '@forgegate/logger';
import axios from 'axios';

@Injectable()
export class WorkflowEngineService {
  private structuredLogger = new StructuredLogger('workflow-engine');

  constructor(private readonly prisma: PrismaService) {}

  async executeExecution(executionId: string, tenantId: string, attemptCount: number = 1): Promise<any> {
    const startTime = Date.now();

    const execution = await this.prisma.workflowExecution.findFirst({
      where: { id: executionId, tenantId },
      include: {
        workflow: {
          include: {
            steps: {
              orderBy: { stepOrder: 'asc' },
            },
          },
        },
      },
    });

    if (!execution) {
      throw new Error(`Workflow execution ${executionId} not found for tenant ${tenantId}`);
    }

    // State transition to 'running' or 'retrying'
    const statusState = attemptCount > 1 ? 'retrying' : 'running';
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: { status: statusState },
    });

    this.structuredLogger.logEvent('workflow_execution_started', {
      tenantId,
      workflowId: execution.workflowId,
      executionId: execution.id,
      attemptCount,
    });

    const steps = execution.workflow.steps;
    let stepPayloadInput = execution.metadata || {};

    try {
      for (const step of steps) {
        if (step.stepOrder < execution.currentStep) {
          continue; // Skip already completed steps
        }

        await this.prisma.workflowExecution.update({
          where: { id: executionId },
          data: { currentStep: step.stepOrder },
        });

        const stepResult = await this.executeStep(step, stepPayloadInput);

        await this.prisma.executionLog.create({
          data: {
            executionId: execution.id,
            stepId: step.id,
            status: 'completed',
            output: stepResult as any,
          },
        });

        const currentPayload = (stepPayloadInput && typeof stepPayloadInput === 'object') ? (stepPayloadInput as Record<string, any>) : {};
        stepPayloadInput = { ...currentPayload, [`step_${step.stepOrder}`]: stepResult };
      }

      // Transition to 'completed'
      const durationMs = Date.now() - startTime;
      await this.prisma.workflowExecution.update({
        where: { id: executionId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          metadata: stepPayloadInput as any,
        },
      });

      this.structuredLogger.logEvent('workflow_execution_completed', {
        tenantId,
        workflowId: execution.workflowId,
        executionId: execution.id,
        durationMs,
      });

      return { status: 'completed', durationMs };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      await this.prisma.executionLog.create({
        data: {
          executionId: execution.id,
          status: 'failed',
          error: error.message || 'Unknown step execution error',
        },
      });

      this.structuredLogger.error('Workflow step execution failed', error.stack, {
        tenantId,
        workflowId: execution.workflowId,
        executionId: execution.id,
        durationMs,
      });

      throw error;
    }
  }

  private async executeStep(step: any, input: any): Promise<any> {
    const config = step.config || {};

    switch (step.actionType) {
      case 'http_request': {
        const url = config.url || 'https://httpbin.org/get';
        const method = (config.method || 'GET').toUpperCase();
        const headers = config.headers || {};
        const body = config.body || input;

        try {
          const response = await axios({
            url,
            method,
            headers,
            data: method !== 'GET' ? body : undefined,
            timeout: 5000,
          });
          return { statusCode: response.status, data: response.data };
        } catch (err: any) {
          throw new Error(`HTTP ${method} to ${url} failed: ${err.message}`);
        }
      }

      case 'data_transform': {
        const mapping = config.mapping || {};
        const transformed: Record<string, any> = {};
        for (const [key, val] of Object.entries(mapping)) {
          transformed[key] = val;
        }
        return { transformed: true, output: transformed };
      }

      case 'email_notification': {
        const recipient = config.recipient || 'user@example.com';
        const subject = config.subject || 'Workflow Notification';
        return { queuedNotification: true, recipient, subject, sentAt: new Date().toISOString() };
      }

      default:
        return { executed: true, stepType: step.actionType, timestamp: new Date().toISOString() };
    }
  }

  async markAsFailed(executionId: string, errorReason: string) {
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        status: 'failed',
        completedAt: new Date(),
      },
    });

    await this.prisma.executionLog.create({
      data: {
        executionId,
        status: 'failed_dead_letter',
        error: errorReason,
      },
    });
  }
}
