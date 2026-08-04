import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  onModuleInit() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    this.client = new Redis({
      host,
      port,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
  }

  onModuleDestroy() {
    if (this.client) {
      this.client.disconnect();
    }
  }

  async blacklistToken(tokenId: string, ttlSeconds: number = 86400): Promise<void> {
    await this.client.setex(`bl_${tokenId}`, ttlSeconds, 'revoked');
  }

  async isTokenBlacklisted(tokenId: string): Promise<boolean> {
    const res = await this.client.get(`bl_${tokenId}`);
    return res === 'revoked';
  }

  getClient(): Redis {
    return this.client;
  }
}
