import { Controller, Get, OnModuleDestroy } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import Redis from 'ioredis';
import axios from 'axios';
import { StructuredLogger } from '@forgegate/logger';

@ApiTags('System Health')
@Controller('health')
export class HealthController implements OnModuleDestroy {
  private redis: Redis;
  private logger = new StructuredLogger('health-controller');

  constructor() {
    if (process.env.REDIS_URL) {
      this.redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    } else {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || undefined;
      this.redis = new Redis({ host, port, password, maxRetriesPerRequest: 1 });
    }
  }

  async onModuleDestroy() {
    this.logger.log('Closing Redis connection in HealthController...');
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch (e) {
        this.redis.disconnect();
      }
    }
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
        services: {
          authService: authHealth,
          workflowService: workflowHealth,
          notificationService: notificationHealth,
        },
      },
    };
  }

  private async checkServiceHealth(baseUrl: string, path: string) {
    try {
      const response = await axios.get(`${baseUrl}${path}`, { timeout: 2000 });
      return {
        status: response.status === 200 ? 'up' : 'down',
        statusCode: response.status,
        url: `${baseUrl}${path}`,
      };
    } catch (err: any) {
      return {
        status: 'down',
        error: err.message,
        url: `${baseUrl}${path}`,
      };
    }
  }
}
