import Redis from 'ioredis';
import { extractProviderFromUrlOrConfig } from './outbound-rate-limiter';

export interface OutboundConcurrencyConfig {
  globalMaxConcurrency?: number;
  tenantLimits?: Record<string, number>; // tenantId -> maxConcurrency
  providerLimits?: Record<string, number>; // provider -> maxConcurrency
  tenantProviderLimits?: Record<string, Record<string, number>>; // tenantId -> provider -> maxConcurrency
  stepLimits?: Record<string, number>; // stepId -> maxConcurrency
}

export interface CheckOutboundConcurrencyParams {
  tenantId: string;
  provider?: string;
  url?: string;
  workflowId?: string;
  stepId?: string;
  stepConfig?: any;
}

export interface ConcurrencyLease {
  leaseId: string;
  acquiredKeys: string[];
}

export interface OutboundConcurrencyResult {
  acquired: boolean;
  lease?: ConcurrencyLease;
  exceededScope?: 'global' | 'tenant' | 'provider' | 'tenant_provider' | 'step';
  retryAfterSeconds?: number;
  currentCount?: number;
  limit?: number;
}

export class OutboundConcurrencyLimiter {
  private redis: Redis;
  private config: OutboundConcurrencyConfig;
  private defaultLeaseTtl = 60; // seconds

  private metrics = {
    acquiredTotal: 0,
    rejectedTotal: 0,
    releasedTotal: 0,
    deferredTotal: 0,
  };

  constructor(redisInstance?: Redis, config?: OutboundConcurrencyConfig) {
    if (redisInstance) {
      this.redis = redisInstance;
    } else {
      if (process.env.REDIS_URL) {
        this.redis = new Redis(process.env.REDIS_URL);
      } else {
        const host = process.env.REDIS_HOST || 'localhost';
        const port = parseInt(process.env.REDIS_PORT || '6379', 10);
        const password = process.env.REDIS_PASSWORD || undefined;
        this.redis = new Redis({ host, port, password });
      }
    }

    this.config = config || {};
  }

  public setConfig(config: OutboundConcurrencyConfig) {
    this.config = config;
  }

  public getConfig(): OutboundConcurrencyConfig {
    return this.config;
  }

  public getMetrics() {
    return { ...this.metrics };
  }

  public async acquire(
    params: CheckOutboundConcurrencyParams,
  ): Promise<OutboundConcurrencyResult> {
    const provider = extractProviderFromUrlOrConfig(
      params.stepConfig || { provider: params.provider, url: params.url },
    );
    const tenantId = params.tenantId || 'default';
    const stepConfig = params.stepConfig || {};

    const scopesToCheck: Array<{
      scope: 'step' | 'tenant_provider' | 'tenant' | 'provider' | 'global';
      key: string;
      limit: number;
    }> = [];

    // 1. Step limit
    const stepLimit =
      stepConfig.outboundConcurrency ||
      (params.stepId ? this.config.stepLimits?.[params.stepId] : undefined);
    if (stepLimit && stepLimit > 0) {
      const stepKey = `outbound:conc:step:${tenantId}:${params.workflowId || 'wf'}:${params.stepId || 'step'}`;
      scopesToCheck.push({ scope: 'step', key: stepKey, limit: stepLimit });
    }

    // 2. Tenant + Provider limit
    const tpLimit = this.config.tenantProviderLimits?.[tenantId]?.[provider];
    if (tpLimit && tpLimit > 0) {
      const tpKey = `outbound:conc:tenant_provider:${tenantId}:${provider}`;
      scopesToCheck.push({ scope: 'tenant_provider', key: tpKey, limit: tpLimit });
    }

    // 3. Tenant limit
    const tenantLimit = this.config.tenantLimits?.[tenantId];
    if (tenantLimit && tenantLimit > 0) {
      const tKey = `outbound:conc:tenant:${tenantId}`;
      scopesToCheck.push({ scope: 'tenant', key: tKey, limit: tenantLimit });
    }

    // 4. Provider limit
    const providerLimit = this.config.providerLimits?.[provider];
    if (providerLimit && providerLimit > 0) {
      const pKey = `outbound:conc:provider:${provider}`;
      scopesToCheck.push({ scope: 'provider', key: pKey, limit: providerLimit });
    }

    // 5. Global limit
    const globalLimit = this.config.globalMaxConcurrency;
    if (globalLimit && globalLimit > 0) {
      const gKey = `outbound:conc:global`;
      scopesToCheck.push({ scope: 'global', key: gKey, limit: globalLimit });
    }

    const acquiredKeys: string[] = [];

    for (const item of scopesToCheck) {
      const { scope, key, limit } = item;
      try {
        const count = await this.redis.incr(key);
        await this.redis.expire(key, this.defaultLeaseTtl);

        if (count > limit) {
          await this.redis.decr(key);
          for (const acquiredKey of acquiredKeys) {
            await this.redis.decr(acquiredKey);
          }

          this.metrics.rejectedTotal++;
          this.metrics.deferredTotal++;

          return {
            acquired: false,
            exceededScope: scope,
            retryAfterSeconds: 2,
            currentCount: count - 1,
            limit,
          };
        }

        acquiredKeys.push(key);
      } catch (err) {
        // Fail-open if Redis drops connection
      }
    }

    const leaseId = `lease:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;
    this.metrics.acquiredTotal++;

    return {
      acquired: true,
      lease: {
        leaseId,
        acquiredKeys,
      },
    };
  }

  public async release(lease?: ConcurrencyLease): Promise<void> {
    if (!lease || !lease.acquiredKeys || lease.acquiredKeys.length === 0) {
      return;
    }

    for (const key of lease.acquiredKeys) {
      try {
        const count = await this.redis.decr(key);
        if (count < 0) {
          await this.redis.set(key, '0');
        }
      } catch (err) {
        // Silence transient errors during lease release
      }
    }

    this.metrics.releasedTotal++;
  }

  public async disconnect() {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
