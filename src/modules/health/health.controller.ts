import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('Health & Metrics')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check health status of backend infrastructure services' })
  @ApiResponse({ status: 200, description: 'Health check details' })
  async getHealth() {
    return this.healthService.check();
  }
}
