import { Module, Get, Controller, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { DashboardController } from './dashboard.controller';

@ApiTags('Gateway Observability')
@Controller()
export class GatewayController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('health')
  @ApiOperation({ summary: 'API Gateway Health Status' })
  getHealth() {
    return {
      status: 'ok',
      service: 'api-gateway',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Prometheus Metrics Endpoint' })
  async getMetrics(@Res() res: Response) {
    const metrics = await this.metricsService.getMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(metrics);
  }
}

@Module({
  controllers: [GatewayController, DashboardController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class AppModule {}
