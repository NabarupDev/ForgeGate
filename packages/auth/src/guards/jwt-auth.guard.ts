import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { UserContext } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // 1. Check if req.user is already populated by API Gateway or middleware
    if (request.user && request.user.id && request.user.tenantId) {
      return true;
    }

    // 2. Extract Authorization header
    const authHeader = request.headers['authorization'] || request.headers['Authorization'];
    if (!authHeader) {
      // Fallback: If development/testing bypass headers are provided
      const devUserId = request.headers['x-user-id'];
      const devTenantId = request.headers['x-tenant-id'];
      const devRole = request.headers['x-user-role'] || 'user';

      if (devUserId && devTenantId) {
        request.user = {
          id: String(devUserId),
          email: `${devUserId}@forgegate.internal`,
          role: String(devRole),
          tenantId: String(devTenantId),
        } as UserContext;
        return true;
      }

      throw new UnauthorizedException('Missing authorization token');
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization header format');
    }

    try {
      // Parse base64 JWT payload safely
      const payloadPart = token.split('.')[1];
      if (!payloadPart) {
        throw new UnauthorizedException('Malformed JWT token');
      }

      const decodedString = Buffer.from(payloadPart, 'base64').toString('utf-8');
      const payload = JSON.parse(decodedString);

      if (!payload || !payload.sub || !payload.tenantId) {
        throw new UnauthorizedException('Invalid JWT payload claims');
      }

      request.user = {
        id: payload.sub,
        email: payload.email || '',
        role: payload.role || 'user',
        tenantId: payload.tenantId,
      } as UserContext;

      return true;
    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Failed to authenticate token');
    }
  }
}
