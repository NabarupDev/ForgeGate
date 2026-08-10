import { INestApplication } from '@nestjs/common';
import * as express from 'express';

export interface HttpHardeningOptions {
  bodySizeLimit?: string;
  requestTimeoutMs?: number;
}

export function buildCorsOptions() {
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
  let allowedOrigins: string[] = [];

  if (envOrigins && envOrigins.trim()) {
    allowedOrigins = envOrigins
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  } else if (process.env.NODE_ENV !== 'production') {
    // Local development origins
    allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:8080',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
    ];
  } else {
    // Production default: require explicit origins
    allowedOrigins = [];
  }

  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (e.g. server-to-server, curl, mobile apps)
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS policy violation: Origin '${origin}' is not allowed`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-Tenant-Id',
      'Idempotency-Key',
      'x-api-key',
    ],
    credentials: true,
    optionsSuccessStatus: 204,
  };
}

export function applyHttpHardening(app: INestApplication, options?: HttpHardeningOptions) {
  const httpAdapter = app.getHttpAdapter();
  const expressInstance = httpAdapter ? httpAdapter.getInstance() : null;

  // 1. Framework Identification Header Removal
  if (expressInstance && typeof expressInstance.disable === 'function') {
    expressInstance.disable('x-powered-by');
  }

  // 2. Security Headers & HTTP Method Filter Middleware
  app.use((req: any, res: any, next: any) => {
    if (res.removeHeader) {
      res.removeHeader('X-Powered-By');
      res.removeHeader('Server');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_HSTS === 'true') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https: data:; connect-src 'self' ws: wss: http: https:;",
    );

    const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
    if (req.method && !allowedMethods.includes(req.method.toUpperCase())) {
      return res.status(405).json({
        statusCode: 405,
        error: 'Method Not Allowed',
        message: `HTTP method ${req.method} is not permitted`,
      });
    }

    next();
  });

  // 3. Request Body Size Limits
  const limit = options?.bodySizeLimit || process.env.MAX_REQUEST_BODY_SIZE || '1mb';
  app.use(express.json({ limit }));
  app.use(express.urlencoded({ limit, extended: true }));

  // 4. Configurable CORS Policy
  app.enableCors(buildCorsOptions());

  // 5. Request Timeout Middleware
  const timeoutMs = options?.requestTimeoutMs || parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);
  app.use((req: any, res: any, next: any) => {
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => {
        if (!res.headersSent) {
          res.status(408).json({
            statusCode: 408,
            error: 'Request Timeout',
            message: `Request timed out after ${timeoutMs}ms`,
          });
        }
      });
    }
    next();
  });
}
