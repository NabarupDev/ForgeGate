import { MetricsService } from '@forgegate/common';
import { WorkflowEngineService } from '../src/workflow-engine/workflow-engine.service';
import { QueueService } from '../src/queue/queue.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('ForgeGate Observability & End-to-End Correlation Tracing', () => {
  let metricsService: MetricsService;
  let mockPrisma: any;
  let engineService: WorkflowEngineService;
  let queueService: QueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    metricsService = MetricsService.getInstance();

    mockPrisma = {
      workflowExecution: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'exec-obs-1', status: 'pending' }),
      },
      stepExecution: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'step-exec-obs-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      executionLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    engineService = new WorkflowEngineService(mockPrisma as any);
    queueService = new QueueService(engineService);
  });

  describe('Prometheus Metrics & Low-Cardinality Enforcement', () => {
    it('should register and output all required ForgeGate metrics', async () => {
      metricsService.workflowExecutionsTotal.inc({ status: 'started' });
      metricsService.workflowExecutionsTotal.inc({ status: 'succeeded' });
      metricsService.stepExecutionsTotal.inc({ action_type: 'http_request', status: 'succeeded' });
      metricsService.outboundHttpRequestsTotal.inc({ provider: 'api.external.com', status_code: '200' });
      metricsService.backpressureRejectionsTotal.inc({ type: 'rate_limit' });

      const metricsOutput = await metricsService.getMetrics();

      expect(metricsOutput).toContain('forgegate_workflow_executions_total');
      expect(metricsOutput).toContain('forgegate_step_executions_total');
      expect(metricsOutput).toContain('forgegate_queue_depth');
      expect(metricsOutput).toContain('forgegate_outbound_http_requests_total');
      expect(metricsOutput).toContain('forgegate_backpressure_rejections_total');
    });

    it('should NEVER contain high-cardinality labels such as executionId, stepId, or jobId in metric labels', async () => {
      const metricsOutput = await metricsService.getMetrics();

      expect(metricsOutput).not.toContain('executionId=');
      expect(metricsOutput).not.toContain('stepId=');
      expect(metricsOutput).not.toContain('jobId=');
      expect(metricsOutput).not.toContain('correlationId=');
    });
  });

  describe('End-to-End Correlation ID Propagation', () => {
    it('should forward x-correlation-id in outbound HTTP headers to external providers', async () => {
      const mockWorkflowExecution = {
        id: 'exec-corr-99',
        tenantId: 'tenant-obs',
        workflowId: 'wf-obs',
        currentStep: 1,
        metadata: { correlationId: 'corr-trace-12345' },
        workflow: {
          steps: [
            {
              id: 'step-http-1',
              stepOrder: 1,
              actionType: 'http_request',
              config: {
                url: 'https://api.partner.com/v1/webhook',
                method: 'POST',
              },
            },
          ],
        },
      };

      mockPrisma.workflowExecution.findFirst.mockResolvedValue(mockWorkflowExecution);
      mockedAxios.mockResolvedValueOnce({ status: 200, data: { success: true } });

      await engineService.executeExecution('exec-corr-99', 'tenant-obs', 1, 'corr-trace-12345');

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.partner.com/v1/webhook',
          headers: expect.objectContaining({
            'x-correlation-id': 'corr-trace-12345',
          }),
        }),
      );
    });

    it('should preserve correlationId when enqueuing workflow execution jobs', async () => {
      const enqueueSpy = jest.spyOn(queueService, 'enqueueWorkflowExecution');
      await queueService.addExecutionJob('exec-corr-99', 'tenant-obs', 'corr-trace-12345');

      expect(enqueueSpy).toHaveBeenCalledWith('exec-corr-99', 'tenant-obs', 'corr-trace-12345');
    });
  });
});
