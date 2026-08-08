import { HttpException, HttpStatus, BadRequestException, UnauthorizedException, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { AllExceptionsFilter } from '@forgegate/common';
import { ProxyService } from '../../api-gateway/src/proxy/proxy.service';
import { ExecutionService } from '../src/execution/execution.service';

describe('ForgeGate API Information Disclosure & Security Audit Test Suite', () => {
  let filter: AllExceptionsFilter;

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    return res;
  };

  const mockHost = (req: any, res: any) => ({
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  });

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  describe('1. Database / Prisma Exception Sanitization', () => {
    it('should sanitize Prisma P2002 unique constraint error into 409 RESOURCE_CONFLICT', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/users', method: 'POST', headers: { 'x-request-id': 'req-p2002' } };
      const prismaError = {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
        message: 'Unique constraint failed on the fields: (`email`) at PostgreSQL table public.User',
        clientVersion: '5.10.0',
      };

      filter.catch(prismaError, mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'A resource with this unique attribute already exists.',
          },
          requestId: 'req-p2002',
          path: '/api/v1/users',
        }),
      );

      const responsePayload = res.json.mock.calls[0][0];
      const payloadString = JSON.stringify(responsePayload);
      expect(payloadString).not.toContain('PostgreSQL');
      expect(payloadString).not.toContain('Prisma');
      expect(payloadString).not.toContain('public.User');
    });

    it('should sanitize Prisma database connection failure into 503 SERVICE_UNAVAILABLE', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/workflows', method: 'GET', headers: {} };
      const initError = {
        name: 'PrismaClientInitializationError',
        message: "Can't reach database server at localhost:5432. Please make sure your database server is running.",
      };

      filter.catch(initError, mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Service temporarily unavailable. Please try again later.',
          },
        }),
      );

      const payloadString = JSON.stringify(res.json.mock.calls[0][0]);
      expect(payloadString).not.toContain('localhost:5432');
      expect(payloadString).not.toContain('database server');
      expect(payloadString).not.toContain('Prisma');
    });
  });

  describe('2. Network / Connection Error Sanitization', () => {
    it('should sanitize ECONNREFUSED network failure without leaking IP/port', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/proxy/auth', method: 'POST', headers: { 'x-correlation-id': 'corr-conn-refused' } };
      const netError = {
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 127.0.0.1:3001',
        stack: 'Error: connect ECONNREFUSED 127.0.0.1:3001\n at TCPConnectWrap.afterConnect [as oncomplete]',
      };

      filter.catch(netError, mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Service temporarily unavailable. Please try again later.',
          },
          requestId: 'corr-conn-refused',
        }),
      );

      const payloadString = JSON.stringify(res.json.mock.calls[0][0]);
      expect(payloadString).not.toContain('127.0.0.1');
      expect(payloadString).not.toContain('3001');
      expect(payloadString).not.toContain('ECONNREFUSED');
      expect(payloadString).not.toContain('stack');
    });
  });

  describe('3. Validation Failure Formatting', () => {
    it('should format NestJS ValidationPipe errors into clean VALIDATION_ERROR response', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/auth/register', method: 'POST', headers: {} };
      const validationException = new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['email must be an email address', 'password must be at least 8 characters'],
      });

      filter.catch(validationException, mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'One or more fields are invalid.',
            details: ['email must be an email address', 'password must be at least 8 characters'],
          },
        }),
      );
    });
  });

  describe('4. Standard HTTP Exceptions (401, 403, 404, 409)', () => {
    it('should sanitize 401 UnauthorizedException', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/workflows', method: 'GET', headers: {} };

      filter.catch(new UnauthorizedException('Invalid or expired token'), mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
          },
        }),
      );
    });

    it('should sanitize 403 ForbiddenException', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/workflows/wf-1', method: 'DELETE', headers: {} };

      filter.catch(new ForbiddenException('You do not have permission to delete this workflow'), mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have permission to delete this workflow',
          },
        }),
      );
    });

    it('should sanitize 404 NotFoundException', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/workflows/wf-999', method: 'GET', headers: {} };

      filter.catch(new NotFoundException('Workflow not found'), mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Workflow not found',
          },
        }),
      );
    });
  });

  describe('5. Unhandled / Unknown Exception Leak Protection', () => {
    it('should never expose raw Error stack traces or filesystem paths to client', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/executions/exec-1', method: 'POST', headers: {} };
      const rawError = new Error('Unexpected NullPointer at /var/app/src/service.ts:145 with secret DB_PASS=supersecret');

      filter.catch(rawError, mockHost(req, res) as any);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected error occurred.',
          },
        }),
      );

      const payloadString = JSON.stringify(res.json.mock.calls[0][0]);
      expect(payloadString).not.toContain('supersecret');
      expect(payloadString).not.toContain('/var/app/src');
      expect(payloadString).not.toContain('NullPointer');
      expect(payloadString).not.toContain('stack');
    });
  });

  describe('6. API Gateway Proxy Failure Sanitization', () => {
    it('should sanitize ProxyService connection failures and not leak internal service URLs', async () => {
      const proxyService = new ProxyService();

      try {
        // Attempt to forward request to nonexistent upstream
        await proxyService.forwardRequest('auth', 'test-path', 'GET', {}, {}, {});
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.BAD_GATEWAY);

        const responseObj = err.getResponse();
        expect(responseObj).toEqual({
          message: 'Upstream service unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
        });

        const payloadString = JSON.stringify(responseObj);
        expect(payloadString).not.toContain('127.0.0.1');
        expect(payloadString).not.toContain('3001');
        expect(payloadString).not.toContain('ECONNREFUSED');
      }
    });
  });

  describe('7. Cross-Tenant Enumeration Leak Prevention', () => {
    it('should return NotFoundException when querying an execution owned by another tenant', async () => {
      const mockPrisma = {
        workflowExecution: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'exec-tenant-2',
            tenantId: 'tenant-2',
            workflow: { id: 'wf-2' },
          }),
        },
      };

      const executionService = new ExecutionService(mockPrisma as any, {} as any);
      const userTenant1: any = { id: 'u-1', tenantId: 'tenant-1', role: 'user' };

      await expect(executionService.getExecution('exec-tenant-2', userTenant1)).rejects.toThrow(NotFoundException);
    });
  });

  describe('8. Request Correlation ID Header Verification', () => {
    it('should set x-correlation-id and x-request-id response headers on every error', () => {
      const res = mockResponse();
      const req = { url: '/api/v1/test', method: 'GET', headers: { 'x-correlation-id': 'trace-abc-123' } };

      filter.catch(new BadRequestException('Invalid request parameter'), mockHost(req, res) as any);

      expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'trace-abc-123');
      expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'trace-abc-123');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'trace-abc-123',
        }),
      );
    });
  });
});
