import {
  classifyHttpError,
  parseRetryAfterHeader,
  HttpStepError,
} from '../src/workflow-engine/http-step-classifier';
import {
  calculateRetryDecision,
  calculateExponentialBackoff,
} from '../src/workflow-engine/http-retry-scheduler';

describe('HTTP Step Error Classifier & Intelligent Retry Scheduler Unit Tests', () => {
  describe('parseRetryAfterHeader', () => {
    it('should return null for null/undefined or invalid input', () => {
      expect(parseRetryAfterHeader(null)).toBeNull();
      expect(parseRetryAfterHeader(undefined)).toBeNull();
      expect(parseRetryAfterHeader('invalid-string')).toBeNull();
    });

    it('should parse integer seconds correctly', () => {
      expect(parseRetryAfterHeader('60')).toBe(60);
      expect(parseRetryAfterHeader('120')).toBe(120);
      expect(parseRetryAfterHeader('0')).toBe(0);
    });

    it('should parse HTTP date string correctly', () => {
      const futureDate = new Date(Date.now() + 45000).toUTCString();
      const parsed = parseRetryAfterHeader(futureDate);
      expect(parsed).toBeGreaterThanOrEqual(44);
      expect(parsed).toBeLessThanOrEqual(46);
    });
  });

  describe('HTTP Status Code Error Classification', () => {
    it('should classify 400, 401, 403, 404, 409 as PERMANENT_FAILURE (isRetryable = false)', () => {
      const statusCodes = [400, 401, 403, 404, 409];
      for (const status of statusCodes) {
        const mockAxiosError = {
          response: {
            status,
            headers: {},
            data: { error: 'Client Error' },
          },
        };

        const err = classifyHttpError(mockAxiosError, 'https://api.example.com/item', 'GET');
        expect(err).toBeInstanceOf(HttpStepError);
        expect(err.category).toBe('PERMANENT_FAILURE');
        expect(err.isRetryable).toBe(false);
        expect(err.statusCode).toBe(status);
        expect(err.url).toBe('https://api.example.com/item');
        expect(err.method).toBe('GET');
      }
    });

    it('should classify 408 as TRANSIENT_FAILURE (isRetryable = true)', () => {
      const mockAxiosError = {
        response: {
          status: 408,
          headers: {},
        },
      };

      const err = classifyHttpError(mockAxiosError, 'https://api.example.com/slow', 'POST');
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(408);
      expect(err.subReason).toBe('request_timeout');
    });

    it('should classify 429 as RATE_LIMITED (isRetryable = true) and expose retryAfterSeconds', () => {
      const mockAxiosError = {
        response: {
          status: 429,
          headers: { 'retry-after': '30' },
        },
      };

      const err = classifyHttpError(mockAxiosError, 'https://api.example.com/rate-limited', 'POST');
      expect(err.category).toBe('RATE_LIMITED');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(429);
      expect(err.subReason).toBe('rate_limited');
      expect(err.retryAfterSeconds).toBe(30);
    });

    it('should classify 500, 502, 503, 504 as TRANSIENT_FAILURE (isRetryable = true)', () => {
      const statusCodes = [500, 502, 503, 504];
      for (const status of statusCodes) {
        const mockAxiosError = {
          response: {
            status,
            headers: {},
          },
        };

        const err = classifyHttpError(mockAxiosError, 'https://api.example.com/service', 'PUT');
        expect(err.category).toBe('TRANSIENT_FAILURE');
        expect(err.isRetryable).toBe(true);
        expect(err.statusCode).toBe(status);
        expect(err.subReason).toBe(`server_error_${status}`);
      }
    });
  });

  describe('Network & Timeout Error Classification', () => {
    it('should classify ECONNREFUSED as NETWORK_FAILURE (subReason: connection_refused)', () => {
      const mockError = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8080' };
      const err = classifyHttpError(mockError, 'http://127.0.0.1:8080', 'GET');

      expect(err.category).toBe('NETWORK_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('connection_refused');
    });

    it('should classify ETIMEDOUT as TIMEOUT (subReason: socket_timeout)', () => {
      const mockError = { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' };
      const err = classifyHttpError(mockError, 'https://api.example.com/socket', 'GET');

      expect(err.category).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('socket_timeout');
    });
  });

  describe('Intelligent Retry Scheduler Tests (A - I)', () => {
    const mockCreatedAt = new Date();
    const config = {
      maxNormalRetries: 3,
      maxRateLimitDeferrals: 5,
      maxExecutionLifetimeMs: 3600000, // 1 hour
      initialDelayMs: 1000,
      maxDelayMs: 60000, // 60s max
      jitterMs: 10,
    };

    describe('Test A: 429 with Retry-After seconds', () => {
      it('should schedule retry with exact delay from Retry-After seconds and NOT consume normal retry budget', () => {
        const err = classifyHttpError({
          response: { status: 429, headers: { 'retry-after': '30' } },
        }, 'https://api.example.com', 'POST');

        const decision = calculateRetryDecision(err, 1, 0, mockCreatedAt, config);

        expect(decision.shouldRetry).toBe(true);
        expect(decision.delayMs).toBe(30000); // 30 seconds
        expect(decision.isRateLimitDeferral).toBe(true);
        expect(decision.newRateLimitDeferralsCount).toBe(1);
        expect(decision.newNormalAttemptCount).toBe(1); // Budget NOT consumed
        expect(decision.reason).toBe('rate_limited_deferred');
      });
    });

    describe('Test B: 429 with Retry-After HTTP date', () => {
      it('should parse HTTP date and schedule retry after delay without consuming normal retry budget', () => {
        const futureDate = new Date(Date.now() + 45000).toUTCString();
        const err = classifyHttpError({
          response: { status: 429, headers: { 'retry-after': futureDate } },
        }, 'https://api.example.com', 'GET');

        const decision = calculateRetryDecision(err, 1, 2, mockCreatedAt, config);

        expect(decision.shouldRetry).toBe(true);
        expect(decision.delayMs).toBeGreaterThanOrEqual(44000);
        expect(decision.delayMs).toBeLessThanOrEqual(46000);
        expect(decision.isRateLimitDeferral).toBe(true);
        expect(decision.newRateLimitDeferralsCount).toBe(3);
        expect(decision.newNormalAttemptCount).toBe(1);
      });
    });

    describe('Test C: 429 without Retry-After', () => {
      it('should schedule retry using bounded exponential backoff without consuming normal retry budget', () => {
        const err = classifyHttpError({
          response: { status: 429, headers: {} },
        }, 'https://api.example.com', 'GET');

        const decision = calculateRetryDecision(err, 2, 0, mockCreatedAt, config);

        expect(decision.shouldRetry).toBe(true);
        expect(decision.delayMs).toBeGreaterThanOrEqual(2000);
        expect(decision.delayMs).toBeLessThanOrEqual(2100);
        expect(decision.isRateLimitDeferral).toBe(true);
        expect(decision.newRateLimitDeferralsCount).toBe(1);
        expect(decision.newNormalAttemptCount).toBe(2);
      });
    });

    describe('Test D: 503 with Retry-After', () => {
      it('should schedule retry with Retry-After delay when 503 includes Retry-After header', () => {
        const err = classifyHttpError({
          response: { status: 503, headers: { 'retry-after': '15' } },
        }, 'https://api.example.com/overloaded', 'POST');

        const decision = calculateRetryDecision(err, 1, 0, mockCreatedAt, config);

        expect(decision.shouldRetry).toBe(true);
        expect(decision.delayMs).toBe(15000);
        expect(decision.isRateLimitDeferral).toBe(true);
        expect(decision.newRateLimitDeferralsCount).toBe(1);
        expect(decision.newNormalAttemptCount).toBe(1);
      });
    });

    describe('Test E: 500 exponential backoff', () => {
      it('should use exponential backoff with jitter and consume normal retry budget', () => {
        const err = classifyHttpError({
          response: { status: 500, headers: {} },
        }, 'https://api.example.com/error', 'GET');

        const decision1 = calculateRetryDecision(err, 1, 0, mockCreatedAt, config);
        expect(decision1.shouldRetry).toBe(true);
        expect(decision1.delayMs).toBeGreaterThanOrEqual(1000);
        expect(decision1.delayMs).toBeLessThanOrEqual(1100);
        expect(decision1.isRateLimitDeferral).toBe(false);
        expect(decision1.newNormalAttemptCount).toBe(2); // Budget consumed

        const decision2 = calculateRetryDecision(err, 2, 0, mockCreatedAt, config);
        expect(decision2.shouldRetry).toBe(true);
        expect(decision2.delayMs).toBeGreaterThanOrEqual(2000);
        expect(decision2.delayMs).toBeLessThanOrEqual(2100);
        expect(decision2.newNormalAttemptCount).toBe(3);
      });
    });

    describe('Test F: network timeout', () => {
      it('should classify network/timeout failure and schedule retry using exponential backoff', () => {
        const err = classifyHttpError({
          code: 'ETIMEDOUT',
          message: 'connect ETIMEDOUT',
        }, 'https://api.example.com/socket', 'GET');

        const decision = calculateRetryDecision(err, 1, 0, mockCreatedAt, config);
        expect(decision.shouldRetry).toBe(true);
        expect(decision.isRateLimitDeferral).toBe(false);
        expect(decision.newNormalAttemptCount).toBe(2);
        expect(decision.reason).toBe('transient_backoff_retry');
      });
    });

    describe('Test G: permanent 400', () => {
      it('should NOT retry permanent 400 failure', () => {
        const err = classifyHttpError({
          response: { status: 400, headers: {}, data: { error: 'Bad Request' } },
        }, 'https://api.example.com/bad', 'POST');

        const decision = calculateRetryDecision(err, 1, 0, mockCreatedAt, config);
        expect(decision.shouldRetry).toBe(false);
        expect(decision.reason).toBe('permanent_failure');
      });
    });

    describe('Test H: maximum rate-limit deferrals', () => {
      it('should stop retrying when maximum rate-limit deferrals threshold (5) is reached', () => {
        const err = classifyHttpError({
          response: { status: 429, headers: { 'retry-after': '10' } },
        }, 'https://api.example.com/limited', 'GET');

        const decision = calculateRetryDecision(err, 1, 5, mockCreatedAt, config);
        expect(decision.shouldRetry).toBe(false);
        expect(decision.reason).toBe('max_rate_limit_deferrals_exceeded');
      });
    });

    describe('Test I: maximum total execution lifetime', () => {
      it('should stop retrying if total execution lifetime exceeds maximum (1 hour)', () => {
        const err = classifyHttpError({
          response: { status: 500, headers: {} },
        }, 'https://api.example.com/old', 'GET');

        const twoHoursAgo = new Date(Date.now() - 7200000);
        const decision = calculateRetryDecision(err, 1, 0, twoHoursAgo, config);

        expect(decision.shouldRetry).toBe(false);
        expect(decision.reason).toBe('max_lifetime_exceeded');
      });
    });
  });
});
