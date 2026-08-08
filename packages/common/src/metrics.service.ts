import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private static instance: MetricsService;
  private register: client.Registry;

  // Workflow Executions
  public workflowExecutionsTotal: client.Counter<'status'>;
  public workflowDuration: client.Histogram<'status'>;

  // Step Executions
  public stepExecutionsTotal: client.Counter<'action_type' | 'status'>;
  public stepRetriesTotal: client.Counter<'action_type'>;
  public stepTimeoutsTotal: client.Counter<'action_type'>;

  // Queue Gauges
  public queueDepthGauge: client.Gauge<string>;
  public activeJobsGauge: client.Gauge<string>;
  public waitingJobsGauge: client.Gauge<string>;
  public failedJobsGauge: client.Gauge<string>;
  public dlqSizeGauge: client.Gauge<string>;

  // Outbound HTTP
  public outboundHttpRequestsTotal: client.Counter<'provider' | 'status_code'>;
  public outboundHttpRequestDuration: client.Histogram<'provider'>;
  public outboundHttpRateLimitDeferralsTotal: client.Counter<'provider'>;
  public outboundHttpTimeoutsTotal: client.Counter<'provider'>;

  // Backpressure
  public backpressureRejectionsTotal: client.Counter<'type'>;
  public backpressureDeferredJobsTotal: client.Counter<'reason'>;

  constructor() {
    // Singleton pattern fallback for non-DI callers if needed
    this.register = client.register || new client.Registry();

    // Default Node process metrics
    try {
      client.collectDefaultMetrics({ register: this.register });
    } catch {
      // Ignore duplicate collection error in test suites
    }

    // 1. Workflow Execution Metrics (Low-cardinality labels only)
    this.workflowExecutionsTotal = this.getOrCreateCounter({
      name: 'forgegate_workflow_executions_total',
      help: 'Total number of workflow executions by status (started, succeeded, failed, timed_out, cancelled)',
      labelNames: ['status'],
    });

    this.workflowDuration = this.getOrCreateHistogram({
      name: 'forgegate_workflow_duration_seconds',
      help: 'Workflow execution duration in seconds',
      labelNames: ['status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    });

    // 2. Step Execution Metrics
    this.stepExecutionsTotal = this.getOrCreateCounter({
      name: 'forgegate_step_executions_total',
      help: 'Total step executions by action type and status',
      labelNames: ['action_type', 'status'],
    });

    this.stepRetriesTotal = this.getOrCreateCounter({
      name: 'forgegate_step_retries_total',
      help: 'Total step retries by action type',
      labelNames: ['action_type'],
    });

    this.stepTimeoutsTotal = this.getOrCreateCounter({
      name: 'forgegate_step_timeouts_total',
      help: 'Total step execution timeouts by action type',
      labelNames: ['action_type'],
    });

    // 3. Queue Gauges
    this.queueDepthGauge = this.getOrCreateGauge({
      name: 'forgegate_queue_depth',
      help: 'Total number of workflow execution jobs in queue (waiting + active)',
    });

    this.activeJobsGauge = this.getOrCreateGauge({
      name: 'forgegate_queue_active_jobs',
      help: 'Current active workflow execution jobs being processed by workers',
    });

    this.waitingJobsGauge = this.getOrCreateGauge({
      name: 'forgegate_queue_waiting_jobs',
      help: 'Current waiting workflow execution jobs in main queue',
    });

    this.failedJobsGauge = this.getOrCreateGauge({
      name: 'forgegate_queue_failed_jobs',
      help: 'Current failed workflow execution jobs',
    });

    this.dlqSizeGauge = this.getOrCreateGauge({
      name: 'forgegate_dlq_size',
      help: 'Current total number of jobs in the Dead Letter Queue (DLQ)',
    });

    // 4. Outbound HTTP Metrics
    this.outboundHttpRequestsTotal = this.getOrCreateCounter({
      name: 'forgegate_outbound_http_requests_total',
      help: 'Total outbound HTTP requests by provider host and status code',
      labelNames: ['provider', 'status_code'],
    });

    this.outboundHttpRequestDuration = this.getOrCreateHistogram({
      name: 'forgegate_outbound_http_duration_seconds',
      help: 'Outbound HTTP request latency in seconds',
      labelNames: ['provider'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });

    this.outboundHttpRateLimitDeferralsTotal = this.getOrCreateCounter({
      name: 'forgegate_outbound_http_rate_limit_deferrals_total',
      help: 'Total rate-limit deferrals (e.g. HTTP 429 Retry-After) by provider',
      labelNames: ['provider'],
    });

    this.outboundHttpTimeoutsTotal = this.getOrCreateCounter({
      name: 'forgegate_outbound_http_timeouts_total',
      help: 'Total outbound HTTP timeouts by provider',
      labelNames: ['provider'],
    });

    // 5. Backpressure Metrics
    this.backpressureRejectionsTotal = this.getOrCreateCounter({
      name: 'forgegate_backpressure_rejections_total',
      help: 'Total backpressure rejections by type (rate_limit, concurrency)',
      labelNames: ['type'],
    });

    this.backpressureDeferredJobsTotal = this.getOrCreateCounter({
      name: 'forgegate_backpressure_deferred_jobs_total',
      help: 'Total deferred jobs due to backpressure limits by reason (rate_limit, concurrency)',
      labelNames: ['reason'],
    });

    MetricsService.instance = this;
  }

  public static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  onModuleInit() {}

  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  getRegistry(): client.Registry {
    return this.register;
  }

  private getOrCreateCounter<T extends string>(config: client.CounterConfiguration<T>): client.Counter<T> {
    const existing = this.register.getSingleMetric(config.name);
    if (existing) return existing as client.Counter<T>;
    return new client.Counter({ ...config, registers: [this.register] });
  }

  private getOrCreateHistogram<T extends string>(config: client.HistogramConfiguration<T>): client.Histogram<T> {
    const existing = this.register.getSingleMetric(config.name);
    if (existing) return existing as client.Histogram<T>;
    return new client.Histogram({ ...config, registers: [this.register] });
  }

  private getOrCreateGauge<T extends string>(config: client.GaugeConfiguration<T>): client.Gauge<T> {
    const existing = this.register.getSingleMetric(config.name);
    if (existing) return existing as client.Gauge<T>;
    return new client.Gauge({ ...config, registers: [this.register] });
  }
}
