import {
  classifyHttpError,
  classifyHttpSuccess,
  parseRetryAfterHeader,
  HttpStepError,
  HttpStepCategory,
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

  describe('SUCCESS Classification', () => {
    it('should classify 200 as SUCCESS', () => {
      const result = classifyHttpSuccess(200, 'https://api.example.com/data', 'GET');
      expect(result.category).toBe('SUCCESS');
      expect(result.isRetryable).toBe(false);
      expect(result.statusCode).toBe(200);
      expect(result.subReason).toBe('success_200');
    });

    it('should classify 201 as SUCCESS', () => {
      const result = classifyHttpSuccess(201, 'https://api.example.com/items', 'POST');
      expect(result.category).toBe('SUCCESS');
      expect(result.isRetryable).toBe(false);
      expect(result.statusCode).toBe(201);
      expect(result.subReason).toBe('success_201');
    });

    it('should classify 204 as SUCCESS', () => {
      const result = classifyHttpSuccess(204, 'https://api.example.com/items/1', 'DELETE');
      expect(result.category).toBe('SUCCESS');
      expect(result.statusCode).toBe(204);
    });
  });

  describe('PERMANENT_FAILURE Classification', () => {
    it('should classify 400 Bad Request as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 400, headers: {}, data: { error: 'Bad Request' } } },
        'https://api.example.com/item',
        'POST',
      );
      expect(err).toBeInstanceOf(HttpStepError);
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.statusCode).toBe(400);
      expect(err.subReason).toBe('client_error_400');
    });

    it('should classify 401 Unauthorized as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 401, headers: {} } },
        'https://api.example.com/secure',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.statusCode).toBe(401);
      expect(err.subReason).toBe('client_error_401');
    });

    it('should classify 403 Forbidden as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 403, headers: {} } },
        'https://api.example.com/admin',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.statusCode).toBe(403);
    });

    it('should classify 404 Not Found as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 404, headers: {} } },
        'https://api.example.com/missing',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.statusCode).toBe(404);
    });

    it('should classify 409 Conflict as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 409, headers: {} } },
        'https://api.example.com/resource',
        'PUT',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.statusCode).toBe(409);
    });

    it('should classify 422 Unprocessable Entity as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 422, headers: {} } },
        'https://api.example.com/validate',
        'POST',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.statusCode).toBe(422);
      expect(err.subReason).toBe('client_error_422');
    });

    it('should classify 451 Unavailable For Legal Reasons as PERMANENT_FAILURE', () => {
      const err = classifyHttpError(
        { response: { status: 451, headers: {} } },
        'https://api.example.com/blocked',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.statusCode).toBe(451);
    });
  });

  describe('TRANSIENT_FAILURE Classification', () => {
    it('should classify 408 Request Timeout as TRANSIENT_FAILURE (retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 408, headers: {} } },
        'https://api.example.com/slow',
        'POST',
      );
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(408);
      expect(err.subReason).toBe('request_timeout');
    });

    it('should classify 500 Internal Server Error as TRANSIENT_FAILURE (retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 500, headers: {} } },
        'https://api.example.com/error',
        'GET',
      );
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(500);
      expect(err.subReason).toBe('server_error_500');
    });

    it('should classify 502 Bad Gateway as TRANSIENT_FAILURE (retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 502, headers: {} } },
        'https://api.example.com/proxy',
        'GET',
      );
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(502);
      expect(err.subReason).toBe('server_error_502');
    });

    it('should classify 503 Service Unavailable as TRANSIENT_FAILURE (retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 503, headers: {} } },
        'https://api.example.com/down',
        'GET',
      );
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(503);
      expect(err.subReason).toBe('server_error_503');
    });

    it('should classify 504 Gateway Timeout as TRANSIENT_FAILURE (retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 504, headers: {} } },
        'https://api.example.com/gateway',
        'GET',
      );
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(504);
      expect(err.subReason).toBe('server_error_504');
    });

    it('should classify unknown 5xx as TRANSIENT_FAILURE (retryable)', () => {
      const err = classifyHttpError(
        { response: { status: 599, headers: {} } },
        'https://api.example.com/custom',
        'GET',
      );
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(599);
    });
  });

  describe('RATE_LIMITED Classification', () => {
    it('should classify 429 as RATE_LIMITED (retryable) with Retry-After seconds', () => {
      const err = classifyHttpError(
        { response: { status: 429, headers: { 'retry-after': '30' } } },
        'https://api.example.com/rate-limited',
        'POST',
      );
      expect(err.category).toBe('RATE_LIMITED');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(429);
      expect(err.subReason).toBe('rate_limited');
      expect(err.retryAfterSeconds).toBe(30);
    });

    it('should classify 429 without Retry-After as RATE_LIMITED (retryable, retryAfterSeconds null)', () => {
      const err = classifyHttpError(
        { response: { status: 429, headers: {} } },
        'https://api.example.com/limited',
        'GET',
      );
      expect(err.category).toBe('RATE_LIMITED');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(429);
      expect(err.retryAfterSeconds).toBeNull();
    });
  });

  describe('NETWORK_FAILURE Classification', () => {
    it('should classify ECONNREFUSED as NETWORK_FAILURE (retryable, connection_refused)', () => {
      const err = classifyHttpError(
        { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8080' },
        'http://127.0.0.1:8080',
        'GET',
      );
      expect(err.category).toBe('NETWORK_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('connection_refused');
    });

    it('should classify ENOTFOUND as NETWORK_FAILURE (retryable, dns_failure)', () => {
      const err = classifyHttpError(
        { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND invalid.domain' },
        'https://invalid.domain',
        'GET',
      );
      expect(err.category).toBe('NETWORK_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('dns_failure');
    });

    it('should classify EAI_AGAIN as NETWORK_FAILURE (retryable, dns_failure)', () => {
      const err = classifyHttpError(
        { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN api.example.com' },
        'https://api.example.com',
        'GET',
      );
      expect(err.category).toBe('NETWORK_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('dns_failure');
    });

    it('should classify ECONNRESET as NETWORK_FAILURE (retryable, connection_reset)', () => {
      const err = classifyHttpError(
        { code: 'ECONNRESET', message: 'read ECONNRESET' },
        'https://api.example.com/stream',
        'GET',
      );
      expect(err.category).toBe('NETWORK_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('connection_reset');
    });
  });

  describe('TIMEOUT Classification', () => {
    it('should classify ETIMEDOUT as TIMEOUT (retryable, socket_timeout)', () => {
      const err = classifyHttpError(
        { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' },
        'https://api.example.com/socket',
        'GET',
      );
      expect(err.category).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('socket_timeout');
    });

    it('should classify ESOCKETTIMEDOUT as TIMEOUT (retryable, socket_timeout)', () => {
      const err = classifyHttpError(
        { code: 'ESOCKETTIMEDOUT', message: 'socket timeout' },
        'https://api.example.com',
        'POST',
      );
      expect(err.category).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('socket_timeout');
    });

    it('should classify ECONNABORTED as TIMEOUT (retryable, request_timeout)', () => {
      const err = classifyHttpError(
        { code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' },
        'https://api.example.com/timeout',
        'POST',
      );
      expect(err.category).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('request_timeout');
    });

    it('should classify message containing "timed out" as TIMEOUT (retryable, request_timeout)', () => {
      const err = classifyHttpError(
        { message: 'Request timed out after 5000ms' },
        'https://api.example.com/timeout',
        'POST',
      );
      expect(err.category).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('request_timeout');
    });
  });

  describe('TLS / Certificate Error Classification', () => {
    it('should classify UNABLE_TO_VERIFY_LEAF_SIGNATURE as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' },
        'https://api.bad-cert.com',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.subReason).toBe('tls_certificate_error');
    });

    it('should classify CERT_HAS_EXPIRED as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' },
        'https://api.expired-cert.com',
        'POST',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.subReason).toBe('tls_certificate_error');
    });

    it('should classify DEPTH_ZERO_SELF_SIGNED_CERT as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self signed certificate' },
        'https://self-signed.local',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.subReason).toBe('tls_certificate_error');
    });

    it('should classify SELF_SIGNED_CERT_IN_CHAIN as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self signed certificate in certificate chain' },
        'https://chain.local',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.subReason).toBe('tls_certificate_error');
    });

    it('should classify ERR_TLS_CERT_ALTNAME_INVALID as PERMANENT_FAILURE (not retryable)', () => {
      const err = classifyHttpError(
        { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'Hostname/IP does not match certificate' },
        'https://wrong-host.example.com',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.subReason).toBe('tls_certificate_error');
    });

    it('should classify error messages containing "certificate" as PERMANENT_FAILURE', () => {
      const err = classifyHttpError(
        { code: '', message: 'Error: SSL certificate problem: unable to get local issuer certificate' },
        'https://bad-ssl.com',
        'GET',
      );
      expect(err.category).toBe('PERMANENT_FAILURE');
      expect(err.isRetryable).toBe(false);
      expect(err.subReason).toBe('tls_certificate_error');
    });
  });

  describe('Fallback / Unknown Error Classification', () => {
    it('should classify unknown errors as TRANSIENT_FAILURE (retryable)', () => {
      const err = classifyHttpError(
        { code: 'UNKNOWN_CODE', message: 'Something went wrong' },
        'https://api.example.com',
        'GET',
      );
      expect(err.category).toBe('TRANSIENT_FAILURE');
      expect(err.isRetryable).toBe(true);
      expect(err.subReason).toBe('unknown_http_error');
    });
  });

  describe('Structured Serialization (toJSON)', () => {
    it('should properly serialize to JSON object without stack traces', () => {
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

      // Verify no stack trace leaks in serialized form
      expect(json).not.toHaveProperty('stack');
    });
  });

  describe('Category completeness', () => {
    it('should have all six required categories represented across tests', () => {
      const allCategories: HttpStepCategory[] = [
        'SUCCESS',
        'PERMANENT_FAILURE',
        'TRANSIENT_FAILURE',
        'RATE_LIMITED',
        'NETWORK_FAILURE',
        'TIMEOUT',
      ];

      // SUCCESS
      const success = classifyHttpSuccess(200, 'https://api.example.com', 'GET');
      expect(success.category).toBe('SUCCESS');

      // PERMANENT_FAILURE
      const permanent = classifyHttpError({ response: { status: 400, headers: {} } }, 'https://api.example.com', 'GET');
      expect(permanent.category).toBe('PERMANENT_FAILURE');

      // TRANSIENT_FAILURE
      const transient = classifyHttpError({ response: { status: 500, headers: {} } }, 'https://api.example.com', 'GET');
      expect(transient.category).toBe('TRANSIENT_FAILURE');

      // RATE_LIMITED
      const rateLimited = classifyHttpError({ response: { status: 429, headers: {} } }, 'https://api.example.com', 'GET');
      expect(rateLimited.category).toBe('RATE_LIMITED');

      // NETWORK_FAILURE
      const network = classifyHttpError({ code: 'ECONNREFUSED', message: 'refused' }, 'https://api.example.com', 'GET');
      expect(network.category).toBe('NETWORK_FAILURE');

      // TIMEOUT
      const timeout = classifyHttpError({ code: 'ETIMEDOUT', message: 'timed out' }, 'https://api.example.com', 'GET');
      expect(timeout.category).toBe('TIMEOUT');

      const coveredCategories = [success, permanent, transient, rateLimited, network, timeout].map(r =>
        'category' in r ? r.category : (r as any).category,
      );
      for (const cat of allCategories) {
        expect(coveredCategories).toContain(cat);
      }
    });
  });
});
