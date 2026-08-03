import { Module, Get, Controller } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Gateway Health')
@Controller()
export class GatewayController {
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
  @ApiOperation({ summary: 'Prometheus Metrics Placeholder' })
  getMetrics() {
    return '# HELP gateway_requests_total Total HTTP requests\n# TYPE gateway_requests_total counter\ngateway_requests_total 42\n';
  }
}

@Module({
  controllers: [GatewayController],
})
export class AppModule {}
