import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export interface IdempotencyRecord<T = any> {
  status: 'IN_PROGRESS' | 'COMPLETED';
  result?: T;
  createdAt: number;
}

@Injectable()
export class ApiIdempotencyService implements OnModuleDestroy {
  private readonly logger = new Logger(ApiIdempotencyService.name);
  private redis: Redis | null = null;
  private memoryStore = new Map<string, IdempotencyRecord>();

  constructor(redisInstance?: Redis) {
    if (redisInstance) {
      this.redis = redisInstance;
    } else if (process.env.REDIS_URL && process.env.NODE_ENV !== 'test') {
      try {
        this.redis = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: true,
        });
        this.redis.on('error', (err) => {
          this.logger.warn(`Redis connection error in ApiIdempotencyService: ${err.message}`);
        });
      } catch (e: any) {
        this.logger.warn(`Could not initialize Redis client: ${e.message}`);
      }
    }
  }

  public setRedisClient(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Executes a public mutation API call idempotently.
   * If an operation with the same tenant & idempotencyKey is already completed, returns the cached result.
   * If a concurrent operation is in progress, waits safely for it to complete.
   */
  async processIdempotentOperation<T>(
    tenantId: string,
    operationScope: string,
    idempotencyKey: string | undefined | null,
    operation: () => Promise<T>,
    ttlSeconds: number = 86400, // 24 hours default TTL
  ): Promise<T> {
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return operation();
    }

    const cleanTenant = tenantId || 'default';
    const cleanKey = idempotencyKey.trim();
    const storageKey = `idem:api:${cleanTenant}:${operationScope}:${cleanKey}`;
    const lockKey = `${storageKey}:lock`;

    // 1. Try Redis if available
    if (this.redis) {
      try {
        const cachedRaw = await this.redis.get(storageKey);
        if (cachedRaw) {
          const record: IdempotencyRecord<T> = JSON.parse(cachedRaw);
          if (record.status === 'COMPLETED' && record.result !== undefined) {
            this.logger.log(`Reusing cached idempotent result for key '${storageKey}'`);
            return record.result;
          }
        }

        // Try acquiring atomic lock (30s lock TTL)
        const acquired = await this.redis.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
        if (!acquired) {
          // Concurrent request in progress -> poll for completion
          return await this.pollForRedisCompletion<T>(storageKey, lockKey);
        }

        try {
          // Execute operation
          const result = await operation();
          const record: IdempotencyRecord<T> = {
            status: 'COMPLETED',
            result,
            createdAt: Date.now(),
          };
          await this.redis.set(storageKey, JSON.stringify(record), 'EX', ttlSeconds);
          return result;
        } finally {
          await this.redis.del(lockKey).catch(() => {});
        }
      } catch (err: any) {
        this.logger.warn(`Redis idempotency error (${err.message}). Falling back to memory/direct execution.`);
      }
    }

    // 2. In-Memory fallback for local dev / test environments
    return this.processInMemory(storageKey, operation, ttlSeconds);
  }

  private async pollForRedisCompletion<T>(storageKey: string, lockKey: string): Promise<T> {
    const pollIntervalMs = 50;
    const maxWaitMs = 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const cachedRaw = await this.redis?.get(storageKey);
      if (cachedRaw) {
        const record: IdempotencyRecord<T> = JSON.parse(cachedRaw);
        if (record.status === 'COMPLETED' && record.result !== undefined) {
          return record.result;
        }
      }
      const lockExists = await this.redis?.get(lockKey);
      if (!lockExists && !cachedRaw) {
        break; // Lock released without writing result (e.g. failed) -> break to retry
      }
    }

    throw new Error(`Concurrent idempotent request timed out waiting for key '${storageKey}'`);
  }

  private async processInMemory<T>(
    storageKey: string,
    operation: () => Promise<T>,
    ttlSeconds: number,
  ): Promise<T> {
    this.cleanExpiredMemoryStore();

    const existing = this.memoryStore.get(storageKey);
    if (existing) {
      if (existing.status === 'COMPLETED' && existing.result !== undefined) {
        return existing.result;
      }
      if (existing.status === 'IN_PROGRESS') {
        // Poll for in-memory completion
        return this.pollInMemory<T>(storageKey);
      }
    }

    // Mark IN_PROGRESS
    this.memoryStore.set(storageKey, {
      status: 'IN_PROGRESS',
      createdAt: Date.now(),
    });

    try {
      const result = await operation();
      this.memoryStore.set(storageKey, {
        status: 'COMPLETED',
        result,
        createdAt: Date.now(),
      });

      // Schedule cleanup after TTL if not in test environment
      if (process.env.NODE_ENV !== 'test') {
        const timer = setTimeout(() => {
          this.memoryStore.delete(storageKey);
        }, ttlSeconds * 1000);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }

      return result;
    } catch (error) {
      this.memoryStore.delete(storageKey);
      throw error;
    }
  }

  private async pollInMemory<T>(storageKey: string): Promise<T> {
    const pollIntervalMs = 30;
    const maxWaitMs = 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const existing = this.memoryStore.get(storageKey);
      if (existing && existing.status === 'COMPLETED' && existing.result !== undefined) {
        return existing.result;
      }
      if (!existing) {
        break;
      }
    }

    throw new Error(`Concurrent idempotent request timed out waiting for key '${storageKey}'`);
  }

  private cleanExpiredMemoryStore() {
    const now = Date.now();
    const defaultTtlMs = 86400 * 1000;
    for (const [key, val] of this.memoryStore.entries()) {
      if (now - val.createdAt > defaultTtlMs) {
        this.memoryStore.delete(key);
      }
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch (e) {
        this.redis.disconnect();
      }
    }
  }
}
