import { RedisRateLimiterGuard } from '../src/rate-limiter/rate-limiter.guard';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('RedisRateLimiterGuard (Current Behavior Regression Tests)', () => {
  let guard: RedisRateLimiterGuard;
  let mockRedis: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRedis = {
      incr: jest.fn(),
      expire: jest.fn(),
    };

    guard = new RedisRateLimiterGuard();
    (guard as any).redis = mockRedis;
  });

  const createMockContext = (ip: string = '127.0.0.1', tenantId: string = 'tenant-test') => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          ip,
          headers: { 'x-tenant-id': tenantId },
          connection: { remoteAddress: ip },
        }),
      }),
    } as any;
  };

  it('should allow requests under rate limit threshold and set expire on first request', async () => {
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);

    const context = createMockContext('192.168.1.1', 'tenant-alpha');
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockRedis.incr).toHaveBeenCalledWith('rate_tenant-alpha_192.168.1.1');
    expect(mockRedis.expire).toHaveBeenCalledWith('rate_tenant-alpha_192.168.1.1', 60);
  });

  it('should throw HttpException HTTP 429 when request count exceeds 100', async () => {
    mockRedis.incr.mockResolvedValue(101);

    const context = createMockContext('10.0.0.1', 'tenant-beta');

    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);

    try {
      await guard.canActivate(context);
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(err.getResponse()).toEqual({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Maximum 100 requests per minute allowed.',
      });
    }
  });

  it('should fail-open (return true) if Redis connection throws an unexpected error', async () => {
    mockRedis.incr.mockRejectedValue(new Error('Redis connection lost'));

    const context = createMockContext();
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
  });
});
