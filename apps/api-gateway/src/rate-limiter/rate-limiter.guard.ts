import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { StructuredLogger } from '@forgegate/logger';

@Injectable()
export class RedisRateLimiterGuard implements CanActivate, OnModuleDestroy {
  private redis: Redis;
  private windowSeconds = 60;
  private maxRequestsPerWindow = 100;
  private logger = new StructuredLogger('rate-limiter-guard');

  constructor() {
    if (process.env.REDIS_URL) {
      this.redis = new Redis(process.env.REDIS_URL);
    } else {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || undefined;
      this.redis = new Redis({ host, port, password });
    }
  }

  async onModuleDestroy() {
    this.logger.log('Closing Redis connection in RedisRateLimiterGuard...');
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch (e) {
        this.redis.disconnect();
      }
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
    const tenantId = req.headers['x-tenant-id'] || 'global';
    const key = `rate_${tenantId}_${ip}`;

    try {
      const current = await this.redis.incr(key);
      if (current === 1) {
        await this.redis.expire(key, this.windowSeconds);
      }

      if (current > this.maxRequestsPerWindow) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Maximum ${this.maxRequestsPerWindow} requests per minute allowed.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      // Fail-open if Redis is unreachable to avoid blocking requests
      return true;
    }
  }
}
