import {
  classifyHttpError,
  parseRetryAfterHeader,
  HttpStepError,
} from '../src/workflow-engine/http-step-classifier';

describe('HTTP Step Error Classifier Unit Tests', () => {
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

  describe('Network Error Classification', () => {
    it('should classify ECONNREFUSED as NETWORK_FAILURE (subReason: connection_refused)', () => {
      const mockError = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8080' };
      const err = classifyHttpError(mockError, 'http://127.0.0.1:8080', 'GET');

      expect(err.category).toBe('NETWORK_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('connection_refused');
    });

    it('should classify ENOTFOUND and EAI_AGAIN as NETWORK_FAILURE (subReason: dns_failure)', () => {
      for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
        const mockError = { code, message: 'getaddrinfo ENOTFOUND invalid.domain' };
        const err = classifyHttpError(mockError, 'https://invalid.domain', 'GET');

        expect(err.category).toBe('NETWORK_FAILURE');
        expect(err.isRetryable).toBe(true);
        expect(err.subReason).toBe('dns_failure');
      }
    });

    it('should classify ECONNRESET as NETWORK_FAILURE (subReason: connection_reset)', () => {
      const mockError = { code: 'ECONNRESET', message: 'read ECONNRESET' };
      const err = classifyHttpError(mockError, 'https://api.example.com/stream', 'GET');

      expect(err.category).toBe('NETWORK_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('connection_reset');
    });
  });

  describe('Timeout Error Classification', () => {
    it('should classify ETIMEDOUT and ESOCKETTIMEDOUT as TIMEOUT (subReason: socket_timeout)', () => {
      for (const code of ['ETIMEDOUT', 'ESOCKETTIMEDOUT']) {
        const mockError = { code, message: 'connect ETIMEDOUT' };
        const err = classifyHttpError(mockError, 'https://api.example.com/socket', 'GET');

        expect(err.category).toBe('TIMEOUT');
        expect(err.isRetryable).toBe(true);
        expect(err.subReason).toBe('socket_timeout');
      }
    });

    it('should classify ECONNABORTED or message timeout as TIMEOUT (subReason: request_timeout)', () => {
      const mockError1 = { code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' };
      const err1 = classifyHttpError(mockError1, 'https://api.example.com/timeout', 'POST');

      expect(err1.category).toBe('TIMEOUT');
      expect(err1.isRetryable).toBe(true);
      expect(err1.subReason).toBe('request_timeout');

      const mockError2 = { message: 'Request timed out after 5000ms' };
      const err2 = classifyHttpError(mockError2, 'https://api.example.com/timeout', 'POST');

      expect(err2.category).toBe('TIMEOUT');
      expect(err2.isRetryable).toBe(true);
      expect(err2.subReason).toBe('request_timeout');
    });
  });

  describe('Structured Serialization (toJSON)', () => {
    it('should properly serialize to JSON object', () => {
      const mockError = {
        response: {
          status: 429,
          headers: { 'retry-after': '60' },
        },
      };

      const err = classifyHttpError(mockError, 'https://api.example.com/limit', 'DELETE');
      const json = err.toJSON();

      expect(json).toEqual({
        name: 'HttpStepError',
        category: 'RATE_LIMITED',
        isRetryable: true,
        statusCode: 429,
        subReason: 'rate_limited',
        retryAfterSeconds: 60,
        message: 'HTTP DELETE to https://api.example.com/limit failed: Rate limit exceeded (429)',
        url: 'https://api.example.com/limit',
        method: 'DELETE',
      });
    });
  });
});
