import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // Extract or generate Correlation/Request ID
    const requestId =
      request.headers?.['x-correlation-id'] ||
      request.headers?.['x-request-id'] ||
      `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred.';
    let details: any = undefined;

    const errorObj = exception as any;
    const errorName = errorObj?.name || errorObj?.constructor?.name || 'Error';
    const rawErrorMessage = errorObj?.message || String(exception);

    // 1. Database / Prisma / Redis / RabbitMQ Infrastructure Error Sanitization
    if (
      errorName.includes('PrismaClient') ||
      rawErrorMessage.includes('Prisma') ||
      rawErrorMessage.includes('PostgreSQL') ||
      rawErrorMessage.includes('pg_') ||
      rawErrorMessage.includes('Redis') ||
      rawErrorMessage.includes('RabbitMQ') ||
      rawErrorMessage.includes('amqp')
    ) {
      if (errorObj?.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'RESOURCE_CONFLICT';
        message = 'A resource with this unique attribute already exists.';
      } else if (errorObj?.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'RESOURCE_NOT_FOUND';
        message = 'The requested resource was not found.';
      } else if (
        errorName === 'PrismaClientInitializationError' ||
        rawErrorMessage.includes("Can't reach database server") ||
        rawErrorMessage.includes('ECONNREFUSED') ||
        rawErrorMessage.includes('ENOTFOUND')
      ) {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        code = 'SERVICE_UNAVAILABLE';
        message = 'Service temporarily unavailable. Please try again later.';
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        code = 'INTERNAL_SERVER_ERROR';
        message = 'An infrastructure error occurred.';
      }
    }
    // 2. Network / Connection Failures
    else if (
      errorObj?.code === 'ECONNREFUSED' ||
      errorObj?.code === 'ENOTFOUND' ||
      errorObj?.code === 'ETIMEDOUT' ||
      rawErrorMessage.includes('ECONNREFUSED')
    ) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'SERVICE_UNAVAILABLE';
      message = 'Service temporarily unavailable. Please try again later.';
    }
    // 3. NestJS HttpExceptions
    else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      code = this.getErrorCodeFromStatus(status);

      if (typeof res === 'string') {
        message = this.sanitizeMessage(res);
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as any;

        // Validation Pipe array of strings
        if (Array.isArray(resObj.message)) {
          code = 'VALIDATION_ERROR';
          message = 'One or more fields are invalid.';
          details = resObj.message.map((msg: string) => this.sanitizeMessage(msg));
        } else if (typeof resObj.message === 'string') {
          message = this.sanitizeMessage(resObj.message);
        } else if (resObj.error && typeof resObj.error === 'string') {
          message = this.sanitizeMessage(resObj.error);
        }

        if (resObj.code && typeof resObj.code === 'string') {
          code = resObj.code;
        }
      }
    }
    // 4. Fallback Generic Error
    else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = 'INTERNAL_SERVER_ERROR';
      message = 'An unexpected error occurred.';
    }

    // INTERNAL LOGGING: Log scrubbed internal error details with request context
    const sanitizedInternalLog = this.scrubSensitiveLogDetails(
      `[API Error] ${request.method} ${request.url} -> HTTP ${status} (${code}): ${rawErrorMessage}`
    );

    this.logger.error(
      sanitizedInternalLog,
      exception instanceof Error ? exception.stack : undefined,
    );

    // PUBLIC RESPONSE: Safe, standardized payload
    const responsePayload: Record<string, any> = {
      success: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      requestId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.setHeader('x-correlation-id', requestId);
    response.setHeader('x-request-id', requestId);
    response.status(status).json(responsePayload);
  }

  private getErrorCodeFromStatus(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'RESOURCE_NOT_FOUND';
      case 409:
        return 'RESOURCE_CONFLICT';
      case 429:
        return 'RATE_LIMITED';
      case 502:
        return 'BAD_GATEWAY';
      case 503:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }

  private sanitizeMessage(msg: string): string {
    if (!msg) return 'An error occurred.';
    const lower = msg.toLowerCase();

    // Check for infrastructure, connection strings, SQL query syntax, filesystem paths, or secret assignments
    if (
      lower.includes('prisma') ||
      lower.includes('postgresql') ||
      lower.includes('postgres://') ||
      lower.includes('redis://') ||
      lower.includes('amqp://') ||
      lower.includes('axios') ||
      lower.includes('econnrefused') ||
      lower.includes('enotfound') ||
      lower.includes('etimedout') ||
      lower.includes('127.0.0.1') ||
      lower.includes('localhost') ||
      lower.includes('node_modules') ||
      lower.includes('select ') ||
      lower.includes('insert into') ||
      lower.includes('update ') ||
      lower.includes('delete from') ||
      lower.includes('bearer eyj') ||
      lower.includes('password=') ||
      lower.includes('secret=')
    ) {
      return 'An unexpected internal error occurred.';
    }
    return msg;
  }

  private scrubSensitiveLogDetails(logText: string): string {
    return logText
      .replace(/Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, 'Bearer [REDACTED]')
      .replace(/(password|secret|key|token)=[^&\s]+/gi, '$1=[REDACTED]');
  }
}
