import { HttpStepError } from './http-step-classifier';

export interface RetryPolicyConfig {
  maxNormalRetries?: number; // default: 3
  maxRateLimitDeferrals?: number; // default: 5
  maxExecutionLifetimeMs?: number; // default: 3,600,000 (1 hour)
  initialDelayMs?: number; // default: 1000
  maxDelayMs?: number; // default: 60000 (60 seconds)
  jitterMs?: number; // default: 200
}

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
  isRateLimitDeferral: boolean;
  newRateLimitDeferralsCount: number;
  newNormalAttemptCount: number;
}

export function calculateExponentialBackoff(attempt: number, config: RetryPolicyConfig = {}): number {
  const initial = config.initialDelayMs ?? 1000;
  const maxDelay = config.maxDelayMs ?? 60000;
  const jitterMax = config.jitterMs ?? 200;

  const baseDelay = initial * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * jitterMax);
  return Math.min(maxDelay, baseDelay + jitter);
}

export function calculateRetryDecision(
  error: any,
  currentNormalAttempt: number = 1,
  rateLimitDeferralsCount: number = 0,
  executionCreatedAt: Date = new Date(),
  config: RetryPolicyConfig = {},
): RetryDecision {
  const maxLifetimeMs = config.maxExecutionLifetimeMs ?? 3600000; // 1 hour default
  const maxDeferrals = config.maxRateLimitDeferrals ?? 5;
  const maxNormalRetries = config.maxNormalRetries ?? 3;
  const maxDelayMs = config.maxDelayMs ?? 60000;

  // 1. Enforce Maximum Total Execution Lifetime
  const elapsedMs = Date.now() - executionCreatedAt.getTime();
  if (elapsedMs >= maxLifetimeMs) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: 'max_lifetime_exceeded',
      isRateLimitDeferral: false,
      newRateLimitDeferralsCount: rateLimitDeferralsCount,
      newNormalAttemptCount: currentNormalAttempt,
    };
  }

  // 2. Permanent Failure check
  if (error instanceof HttpStepError && !error.isRetryable) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: 'permanent_failure',
      isRateLimitDeferral: false,
      newRateLimitDeferralsCount: rateLimitDeferralsCount,
      newNormalAttemptCount: currentNormalAttempt,
    };
  }

  const isHttpErr = error instanceof HttpStepError;
  const category = isHttpErr ? error.category : undefined;
  const retryAfterSeconds = isHttpErr ? error.retryAfterSeconds : null;

  // 3. Rate Limited or Overload with Retry-After header / 429 / 529
  const isRateLimitedOrOverloaded =
    category === 'RATE_LIMITED' ||
    retryAfterSeconds !== null ||
    (isHttpErr && error.statusCode === 529);

  if (isRateLimitedOrOverloaded) {
    if (rateLimitDeferralsCount >= maxDeferrals) {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason: 'max_rate_limit_deferrals_exceeded',
        isRateLimitDeferral: true,
        newRateLimitDeferralsCount: rateLimitDeferralsCount,
        newNormalAttemptCount: currentNormalAttempt,
      };
    }

    let delayMs: number;
    if (retryAfterSeconds !== null && retryAfterSeconds !== undefined) {
      // Respect Retry-After header (bounded by maxDelayMs and minimum initialDelayMs to avoid immediate retry loops)
      const targetDelayMs = retryAfterSeconds * 1000;
      const initialDelay = config.initialDelayMs ?? 1000;
      const safeDelay = Math.max(initialDelay, targetDelayMs);
      delayMs = Math.min(maxDelayMs, safeDelay);
    } else {
      // Rate limited without Retry-After -> bounded exponential backoff
      delayMs = calculateExponentialBackoff(currentNormalAttempt, config);
    }

    return {
      shouldRetry: true,
      delayMs,
      reason: 'rate_limited_deferred',
      isRateLimitDeferral: true,
      newRateLimitDeferralsCount: rateLimitDeferralsCount + 1,
      newNormalAttemptCount: currentNormalAttempt,
    };
  }

  // 4. Transient / Network / Timeout / Generic retryable error
  if (currentNormalAttempt >= maxNormalRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: 'max_normal_retries_exceeded',
      isRateLimitDeferral: false,
      newRateLimitDeferralsCount: rateLimitDeferralsCount,
      newNormalAttemptCount: currentNormalAttempt,
    };
  }

  const delayMs = calculateExponentialBackoff(currentNormalAttempt, config);
  return {
    shouldRetry: true,
    delayMs,
    reason: 'transient_backoff_retry',
    isRateLimitDeferral: false,
    newRateLimitDeferralsCount: rateLimitDeferralsCount,
    newNormalAttemptCount: currentNormalAttempt + 1, // Consume normal retry budget
  };
}
