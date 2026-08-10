import { Module, Get, Controller, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { DashboardController } from './dashboard.controller';
import { HealthController } from './health/health.controller';
import { ProxyService } from './proxy/proxy.service';
import { ProxyController } from './proxy/proxy.controller';
import { RedisRateLimiterGuard } from './rate-limiter/rate-limiter.guard';

@ApiTags('Gateway Observability')
@Controller()
export class GatewayMetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Prometheus Metrics Endpoint' })
  async getMetrics(@Res() res: Response) {
    const metrics = await this.metricsService.getMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(metrics);
  }
}

@Module({
  controllers: [
    HealthController,
    DashboardController,
    GatewayMetricsController,
    ProxyController,
  ],
  providers: [
    MetricsService,
    ProxyService,
    {
      provide: 'APP_GUARD',
      useClass: RedisRateLimiterGuard,
    },
  ],
  exports: [MetricsService, ProxyService],
})
export class AppModule {}
