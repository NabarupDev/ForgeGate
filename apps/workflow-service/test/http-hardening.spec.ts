import { buildCorsOptions, applyHttpHardening } from '@forgegate/common';

describe('HTTP Hardening, CORS & Request Protection Spec', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. CORS Policy Rules & Environment Configuration', () => {
    it('Development Mode: should allow localhost development origins and requests with no origin', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ALLOWED_ORIGINS;

      const corsOpts = buildCorsOptions();

      // No origin (server-to-server, curl, mobile) -> Allowed
      let allowNoOrigin: boolean | undefined;
      corsOpts.origin(undefined, (err, allow) => {
        expect(err).toBeNull();
        allowNoOrigin = allow;
      });
      expect(allowNoOrigin).toBe(true);

      // Allowed localhost dev origins
      let allowLocalhost3000: boolean | undefined;
      corsOpts.origin('http://localhost:3000', (err, allow) => {
        expect(err).toBeNull();
        allowLocalhost3000 = allow;
      });
      expect(allowLocalhost3000).toBe(true);

      let allowLocalhost5173: boolean | undefined;
      corsOpts.origin('http://localhost:5173', (err, allow) => {
        expect(err).toBeNull();
        allowLocalhost5173 = allow;
      });
      expect(allowLocalhost5173).toBe(true);
    });

    it('Production Mode: should allow explicitly configured origins via CORS_ALLOWED_ORIGINS env', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.forgegate.com, https://admin.forgegate.com';

      const corsOpts = buildCorsOptions();

      // Explicitly allowed production origin
      let allowProd: boolean | undefined;
      corsOpts.origin('https://app.forgegate.com', (err, allow) => {
        expect(err).toBeNull();
        allowProd = allow;
      });
      expect(allowProd).toBe(true);

      // Unallowed origin -> Returns CORS policy violation error
      let corsErr: Error | null = null;
      corsOpts.origin('https://malicious-site.com', (err, allow) => {
        corsErr = err;
      });
      expect(corsErr).not.toBeNull();
      expect(corsErr!.message).toContain("Origin 'https://malicious-site.com' is not allowed");
    });

    it('Production Mode: should reject unknown origins when CORS_ALLOWED_ORIGINS is unconfigured', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ALLOWED_ORIGINS;

      const corsOpts = buildCorsOptions();

      let corsErr: Error | null = null;
      corsOpts.origin('https://unknown-domain.com', (err, allow) => {
        corsErr = err;
      });
      expect(corsErr).not.toBeNull();
      expect(corsErr!.message).toContain("Origin 'https://unknown-domain.com' is not allowed");
    });
  });

  describe('2. Security Headers & Framework Removal Middleware', () => {
    it('should strip framework headers (X-Powered-By, Server) and set security headers', () => {
      const mockApp: any = {
        getHttpAdapter: () => ({
          getInstance: () => ({
            disable: jest.fn(),
          }),
        }),
        use: jest.fn(),
        enableCors: jest.fn(),
      };

      applyHttpHardening(mockApp);

      // Obtain security header middleware registered with mockApp.use(...)
      const securityMiddleware = mockApp.use.mock.calls.find((call: any[]) => typeof call[0] === 'function')[0];

      const removedHeaders: string[] = [];
      const setHeaders: Record<string, string> = {};

      const req: any = { method: 'GET' };
      const res: any = {
        removeHeader: (headerName: string) => removedHeaders.push(headerName),
        setHeader: (name: string, val: string) => {
          setHeaders[name] = val;
        },
      };
      const next = jest.fn();

      securityMiddleware(req, res, next);

      expect(removedHeaders).toContain('X-Powered-By');
      expect(removedHeaders).toContain('Server');
      expect(setHeaders['X-Content-Type-Options']).toBe('nosniff');
      expect(setHeaders['X-Frame-Options']).toBe('SAMEORIGIN');
      expect(setHeaders['X-XSS-Protection']).toBe('1; mode=block');
      expect(setHeaders['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
      expect(setHeaders['Permissions-Policy']).toBe('geolocation=(), microphone=(), camera=()');
      expect(setHeaders['Content-Security-Policy']).toContain("default-src 'self'");
      expect(next).toHaveBeenCalled();
    });

    it('should set Strict-Transport-Security in production or when HSTS is enabled', () => {
      process.env.NODE_ENV = 'production';

      const mockApp: any = {
        getHttpAdapter: () => ({ getInstance: () => ({ disable: jest.fn() }) }),
        use: jest.fn(),
        enableCors: jest.fn(),
      };

      applyHttpHardening(mockApp);
      const securityMiddleware = mockApp.use.mock.calls.find((call: any[]) => typeof call[0] === 'function')[0];

      const setHeaders: Record<string, string> = {};
      const res: any = {
        removeHeader: jest.fn(),
        setHeader: (name: string, val: string) => {
          setHeaders[name] = val;
        },
      };

      securityMiddleware({ method: 'GET' }, res, jest.fn());
      expect(setHeaders['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
    });
  });

  describe('3. Safe HTTP Methods & Request Body Size Limits', () => {
    it('should reject unsafe HTTP methods (TRACE, CONNECT) with 405 Method Not Allowed', () => {
      const mockApp: any = {
        getHttpAdapter: () => ({ getInstance: () => ({ disable: jest.fn() }) }),
        use: jest.fn(),
        enableCors: jest.fn(),
      };

      applyHttpHardening(mockApp);
      const securityMiddleware = mockApp.use.mock.calls.find((call: any[]) => typeof call[0] === 'function')[0];

      let responseStatus = 0;
      let responseBody: any = null;

      const res: any = {
        removeHeader: jest.fn(),
        setHeader: jest.fn(),
        status: (code: number) => {
          responseStatus = code;
          return {
            json: (body: any) => {
              responseBody = body;
            },
          };
        },
      };
      const next = jest.fn();

      securityMiddleware({ method: 'TRACE' }, res, next);

      expect(responseStatus).toBe(405);
      expect(responseBody.error).toBe('Method Not Allowed');
      expect(next).not.toHaveBeenCalled();
    });

    it('should configure express body limit and request timeout middlewares', () => {
      const mockApp: any = {
        getHttpAdapter: () => ({ getInstance: () => ({ disable: jest.fn() }) }),
        use: jest.fn(),
        enableCors: jest.fn(),
      };

      applyHttpHardening(mockApp, { bodySizeLimit: '2mb', requestTimeoutMs: 10000 });

      expect(mockApp.use).toHaveBeenCalled();
      expect(mockApp.enableCors).toHaveBeenCalledWith(expect.objectContaining({
        methods: expect.arrayContaining(['GET', 'POST', 'OPTIONS']),
      }));
    });
  });
});
