import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private register: client.Registry;

  public httpRequestsTotal: client.Counter<string>;
  public httpRequestDuration: client.Histogram<string>;
  public workflowDuration: client.Histogram<string>;
  public activeJobsGauge: client.Gauge<string>;
  public failedJobsCounter: client.Counter<string>;
  public queueSizeGauge: client.Gauge<string>;

  constructor() {
    this.register = new client.Registry();
    client.collectDefaultMetrics({ register: this.register });

    this.httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests processed by ForgeGate Gateway',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register],
    });

    this.httpRequestDuration = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.workflowDuration = new client.Histogram({
      name: 'workflow_duration_seconds',
      help: 'Workflow execution duration in seconds',
      labelNames: ['workflow_id', 'tenant_id', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.register],
    });

    this.activeJobsGauge = new client.Gauge({
      name: 'active_jobs_total',
      help: 'Current active workflow execution jobs',
      registers: [this.register],
    });

    this.failedJobsCounter = new client.Counter({
      name: 'failed_jobs_total',
      help: 'Total failed workflow execution jobs',
      labelNames: ['tenant_id', 'workflow_id'],
      registers: [this.register],
    });

    this.queueSizeGauge = new client.Gauge({
      name: 'queue_size',
      help: 'Current number of jobs waiting in BullMQ queues',
      registers: [this.register],
    });
  }

  onModuleInit() {}

  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  getRegistry(): client.Registry {
    return this.register;
  }
}
