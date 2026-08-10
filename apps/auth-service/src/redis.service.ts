import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { StructuredLogger } from '@forgegate/logger';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;
  private logger = new StructuredLogger('auth-redis-service');

  onModuleInit() {
    if (process.env.REDIS_URL) {
      this.client = new Redis(process.env.REDIS_URL, {
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });
    } else {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || undefined;
      this.client = new Redis({
        host,
        port,
        password,
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });
    }
  }

  async onModuleDestroy() {
    this.logger.log('Closing Redis connection in Auth RedisService...');
    if (this.client) {
      try {
        await this.client.quit();
      } catch (e) {
        this.client.disconnect();
      }
    }
  }

  async blacklistToken(tokenId: string, ttlSeconds: number = 86400): Promise<void> {
    await this.client.setex(`bl_${tokenId}`, ttlSeconds, 'revoked');
  }

  async isTokenBlacklisted(tokenId: string): Promise<boolean> {
    const res = await this.client.get(`bl_${tokenId}`);
    return res === 'revoked';
  }
}
