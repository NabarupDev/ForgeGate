import Redis from 'ioredis';

export interface RateLimitQuota {
  limit: number;
  windowSeconds: number;
}

export interface OutboundRateLimitConfig {
  globalLimit?: RateLimitQuota;
  providerLimits?: Record<string, RateLimitQuota>;
  tenantProviderLimits?: Record<string, Record<string, RateLimitQuota>>; // tenantId -> provider -> quota
  stepLimits?: Record<string, RateLimitQuota>; // stepId -> quota
}

export interface CheckOutboundRateLimitParams {
  tenantId: string;
  provider?: string;
  url?: string;
  workflowId?: string;
  stepId?: string;
  stepConfig?: any;
}

export interface OutboundRateLimitCheckResult {
  allowed: boolean;
  exceededScope?: 'global' | 'provider' | 'tenant_provider' | 'step';
  retryAfterSeconds?: number;
  currentCount?: number;
  limit?: number;
}

export function extractProviderFromUrlOrConfig(config: any): string {
  if (config?.provider && typeof config.provider === 'string' && config.provider.trim()) {
    return config.provider.trim().toLowerCase();
  }
  if (config?.url && typeof config.url === 'string') {
    try {
      const parsedUrl = new URL(config.url);
      return parsedUrl.hostname.toLowerCase();
    } catch {
      // Fallback for relative or malformed URLs
    }
  }
  return 'generic';
}

export class OutboundRateLimiter {
  private redis: Redis;
  private config: OutboundRateLimitConfig;

  constructor(redisInstance?: Redis, config?: OutboundRateLimitConfig) {
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

  public setConfig(config: OutboundRateLimitConfig) {
    this.config = config;
  }

  public getConfig(): OutboundRateLimitConfig {
    return this.config;
  }

  public async checkAndConsume(
    params: CheckOutboundRateLimitParams,
  ): Promise<OutboundRateLimitCheckResult> {
    const provider = extractProviderFromUrlOrConfig(
      params.stepConfig || { provider: params.provider, url: params.url },
    );
    const tenantId = params.tenantId || 'default';
    const stepConfig = params.stepConfig || {};

    const scopesToCheck: Array<{
      scope: 'step' | 'tenant_provider' | 'provider' | 'global';
      key: string;
      quota: RateLimitQuota;
    }> = [];

    // 1. Step-level quota
    const stepQuota =
      stepConfig.outboundRateLimit ||
      stepConfig.rateLimit ||
      (params.stepId ? this.config.stepLimits?.[params.stepId] : undefined);

    if (stepQuota && stepQuota.limit > 0 && stepQuota.windowSeconds > 0) {
      const stepKey = `outbound:rate:step:${tenantId}:${params.workflowId || 'wf'}:${params.stepId || 'step'}`;
      scopesToCheck.push({ scope: 'step', key: stepKey, quota: stepQuota });
    }

    // 2. Tenant + Provider quota
    const tenantProviderQuota = this.config.tenantProviderLimits?.[tenantId]?.[provider];
    if (
      tenantProviderQuota &&
      tenantProviderQuota.limit > 0 &&
      tenantProviderQuota.windowSeconds > 0
    ) {
      const tpKey = `outbound:rate:tenant_provider:${tenantId}:${provider}`;
      scopesToCheck.push({ scope: 'tenant_provider', key: tpKey, quota: tenantProviderQuota });
    }

    // 3. Provider quota
    const providerQuota = this.config.providerLimits?.[provider];
    if (providerQuota && providerQuota.limit > 0 && providerQuota.windowSeconds > 0) {
      const pKey = `outbound:rate:provider:${provider}`;
      scopesToCheck.push({ scope: 'provider', key: pKey, quota: providerQuota });
    }

    // 4. Global outbound quota
    const globalQuota = this.config.globalLimit;
    if (globalQuota && globalQuota.limit > 0 && globalQuota.windowSeconds > 0) {
      const gKey = `outbound:rate:global`;
      scopesToCheck.push({ scope: 'global', key: gKey, quota: globalQuota });
    }

    const consumedKeys: Array<{ key: string }> = [];

    for (const item of scopesToCheck) {
      const { scope, key, quota } = item;
      try {
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, quota.windowSeconds);
        }

        if (count > quota.limit) {
          await this.redis.decr(key);
          for (const consumed of consumedKeys) {
            await this.redis.decr(consumed.key);
          }

          let ttl = await this.redis.ttl(key);
          if (ttl <= 0) {
            ttl = quota.windowSeconds;
          }

          return {
            allowed: false,
            exceededScope: scope,
            retryAfterSeconds: ttl,
            currentCount: count - 1,
            limit: quota.limit,
          };
        }

        consumedKeys.push({ key });
      } catch (err) {
        // Fail-open if Redis encounters connection issues
      }
    }

    return { allowed: true };
  }

  public async disconnect() {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
