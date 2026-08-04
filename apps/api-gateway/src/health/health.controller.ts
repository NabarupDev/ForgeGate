import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import Redis from 'ioredis';
import axios from 'axios';

@ApiTags('System Health')
@Controller('health')
export class HealthController {
  private redis: Redis;

  constructor() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    this.redis = new Redis({ host, port, maxRetriesPerRequest: 1 });
  }

  @Get()
  @ApiOperation({ summary: 'Multi-Service & Dependency Health Check' })
  async getHealth() {
    const timestamp = new Date().toISOString();

    // Redis Health Check
    let redisStatus = 'down';
    try {
      const pingRes = await this.redis.ping();
      if (pingRes === 'PONG') redisStatus = 'up';
    } catch (e) {
      redisStatus = 'down';
    }

    // Microservices Health Checks
    const [authHealth, workflowHealth, notificationHealth] = await Promise.all([
      this.checkServiceHealth(process.env.AUTH_SERVICE_URL || 'http://localhost:3001', '/auth/health'),
      this.checkServiceHealth(process.env.WORKFLOW_SERVICE_URL || 'http://localhost:3002', '/workflows/health'),
      this.checkServiceHealth(process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003', '/notifications/health'),
    ]);

    const overallStatus =
      redisStatus === 'up' &&
      authHealth.status === 'up' &&
      workflowHealth.status === 'up' &&
      notificationHealth.status === 'up'
        ? 'healthy'
        : 'degraded';

    return {
      status: overallStatus,
      timestamp,
      dependencies: {
        redis: { status: redisStatus },
      },
      services: {
        authService: authHealth,
        workflowService: workflowHealth,
        notificationService: notificationHealth,
      },
    };
  }

  private async checkServiceHealth(baseUrl: string, endpoint: string) {
    try {
      const res = await axios.get(`${baseUrl}${endpoint}`, { timeout: 3000 });
      return { status: 'up', statusCode: res.status, details: res.data };
    } catch (err: any) {
      return { status: 'down', error: err.message };
    }
  }
}
