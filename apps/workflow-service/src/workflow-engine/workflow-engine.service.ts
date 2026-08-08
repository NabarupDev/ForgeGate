import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StructuredLogger } from '@forgegate/logger';
import axios from 'axios';
import { classifyHttpError, HttpStepError } from './http-step-classifier';

function sanitizePayload(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizePayload);

  const sensitiveKeys = [
    'authorization',
    'auth',
    'cookie',
    'x-api-key',
    'apikey',
    'token',
    'secret',
    'password',
    'bearer',
    'private_key',
    'access_token',
  ];
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(data)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizePayload(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

@Injectable()
export class WorkflowEngineService {
  private structuredLogger = new StructuredLogger('workflow-engine');

  constructor(private readonly prisma: PrismaService) {}

  async executeExecution(executionId: string, tenantId: string, attemptCount: number = 1): Promise<any> {
    const startTime = Date.now();
    const workerId = process.env.HOSTNAME || `worker-${process.pid}`;

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
      workerId,
    });

    const steps = execution.workflow.steps;
    let stepPayloadInput = execution.metadata || {};

    try {
      for (const step of steps) {
        if (step.stepOrder < execution.currentStep) {
          continue; // Skip steps prior to current sequence
        }

        // Check if step has ALREADY SUCCEEDED in durable storage (idempotency check)
        const existingSucceededExec = await this.prisma.stepExecution.findFirst({
          where: {
            executionId: execution.id,
            stepId: step.id,
            status: 'SUCCEEDED',
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingSucceededExec) {
          this.structuredLogger.logEvent('step_already_completed_skipping', {
            executionId: execution.id,
            stepId: step.id,
            stepOrder: step.stepOrder,
          });

          const cachedOutput = existingSucceededExec.output;
          const currentPayload =
            stepPayloadInput && typeof stepPayloadInput === 'object'
              ? (stepPayloadInput as Record<string, any>)
              : {};
          stepPayloadInput = { ...currentPayload, [`step_${step.stepOrder}`]: cachedOutput };
          continue;
        }

        await this.prisma.workflowExecution.update({
          where: { id: executionId },
          data: { currentStep: step.stepOrder },
        });

        // 1. Create StepExecution in PENDING state
        const stepExec = await this.prisma.stepExecution.create({
          data: {
            executionId: execution.id,
            stepId: step.id,
            attempt: attemptCount,
            status: 'PENDING',
            input: sanitizePayload(stepPayloadInput) as any,
            workerId,
          },
        });

        // 2. Atomic claim: transition StepExecution PENDING -> RUNNING
        const claimResult = await this.prisma.stepExecution.updateMany({
          where: {
            id: stepExec.id,
            status: 'PENDING',
          },
          data: {
            status: 'RUNNING',
            workerId,
            startedAt: new Date(),
            heartbeatAt: new Date(),
          },
        });

        if (claimResult.count === 0) {
          this.structuredLogger.warn(`Could not claim step ${step.id} for execution ${execution.id}`, {
            executionId: execution.id,
            stepId: step.id,
          });
          continue;
        }

        // Start active heartbeat timer (updates heartbeatAt every 5 seconds)
        const heartbeatTimer = setInterval(async () => {
          try {
            await this.prisma.stepExecution.updateMany({
              where: { id: stepExec.id, status: 'RUNNING', workerId },
              data: { heartbeatAt: new Date() },
            });
          } catch (hbErr) {
            // Silence transient heartbeat updates
          }
        }, 5000);

        let stepResult: any;
        try {
          stepResult = await this.executeStep(step, stepPayloadInput);

          // 3. Transition StepExecution RUNNING -> SUCCEEDED
          await this.prisma.stepExecution.update({
            where: { id: stepExec.id },
            data: {
              status: 'SUCCEEDED',
              finishedAt: new Date(),
              output: sanitizePayload(stepResult) as any,
            },
          });
        } catch (stepErr: any) {
          const isHttpErr = stepErr instanceof HttpStepError;
          const isTimeout =
            stepErr.category === 'TIMEOUT' ||
            stepErr.subReason === 'request_timeout' ||
            stepErr.subReason === 'socket_timeout' ||
            stepErr.message?.toLowerCase().includes('timeout') ||
            stepErr.message?.toLowerCase().includes('timed out') ||
            stepErr.code === 'ECONNABORTED' ||
            stepErr.code === 'ETIMEDOUT';

          const endStatus = isTimeout ? 'TIMED_OUT' : 'FAILED';

          // Transition StepExecution RUNNING -> FAILED / TIMED_OUT
          await this.prisma.stepExecution.update({
            where: { id: stepExec.id },
            data: {
              status: endStatus,
              finishedAt: new Date(),
              error: stepErr.message || 'Unknown step execution error',
              output: isHttpErr ? (stepErr.toJSON() as any) : undefined,
            },
          });

          throw stepErr;
        } finally {
          clearInterval(heartbeatTimer);
        }

        // Maintain backward compatibility with ExecutionLog table
        await this.prisma.executionLog.create({
          data: {
            executionId: execution.id,
            stepId: step.id,
            status: 'completed',
            output: stepResult as any,
          },
        });

        const currentPayload =
          stepPayloadInput && typeof stepPayloadInput === 'object'
            ? (stepPayloadInput as Record<string, any>)
            : {};
        stepPayloadInput = { ...currentPayload, [`step_${step.stepOrder}`]: stepResult };
      }

      // Transition execution to 'completed'
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

  /**
   * Identifies RUNNING step executions that haven't updated heartbeat within leaseDurationMs,
   * updates old worker's StepExecution to TIMED_OUT, and returns executions needing recovery.
   */
  async findAndMarkStaleStepExecutions(
    leaseDurationMs: number = 30000,
  ): Promise<Array<{ executionId: string; tenantId: string }>> {
    const cutoffTime = new Date(Date.now() - leaseDurationMs);

    const staleSteps = await this.prisma.stepExecution.findMany({
      where: {
        status: 'RUNNING',
        OR: [
          { heartbeatAt: { lt: cutoffTime } },
          { heartbeatAt: null, startedAt: { lt: cutoffTime } },
        ],
      },
      include: {
        execution: true,
      },
    });

    const recoveredMap = new Map<string, { executionId: string; tenantId: string }>();

    for (const stepExec of staleSteps) {
      // Mark old worker's StepExecution as TIMED_OUT
      const updated = await this.prisma.stepExecution.updateMany({
        where: {
          id: stepExec.id,
          status: 'RUNNING',
        },
        data: {
          status: 'TIMED_OUT',
          finishedAt: new Date(),
          error: 'Worker lease expired (crash detected)',
        },
      });

      if (updated.count > 0 && stepExec.execution) {
        if (stepExec.execution.status === 'running') {
          await this.prisma.workflowExecution.update({
            where: { id: stepExec.execution.id },
            data: { status: 'retrying' },
          });
        }

        recoveredMap.set(stepExec.execution.id, {
          executionId: stepExec.execution.id,
          tenantId: stepExec.execution.tenantId,
        });
      }
    }

    return Array.from(recoveredMap.values());
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
          throw classifyHttpError(err, url, method);
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

  async getExecutionById(executionId: string) {
    return this.prisma.workflowExecution.findUnique({
      where: { id: executionId },
    });
  }
}
