import { Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { StructuredLogger } from '@forgegate/logger';
import { parsePaginationParams, buildPaginatedResult, PaginationQuery, PaginatedResult } from '@forgegate/common';

export interface RegisterDto {
  email: string;
  password: string;
  name: string;
  tenantSlug?: string;
  tenantName?: string;
  roleName?: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

@Injectable()
export class AuthService {
  private logger = new StructuredLogger('auth-service');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new BadRequestException('User with this email already exists');
    }

    // Resolve tenant
    let tenant;
    const slug = dto.tenantSlug || 'default-tenant';
    tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      tenant = await this.prisma.tenant.create({
        data: {
          name: dto.tenantName || dto.tenantSlug || 'Default Tenant',
          slug,
        },
      });
    }

    // Resolve role
    const roleName = dto.roleName || 'user';
    let role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      role = await this.prisma.role.create({
        data: { name: roleName, description: 'Standard user role' },
      });
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        passwordHash,
        tenantId: tenant.id,
        roleId: role.id,
      },
      include: {
        role: true,
        tenant: true,
      },
    });

    this.logger.logEvent('user_registered', {
      tenantId: tenant.id,
      userId: user.id,
      email: user.email,
    });

    const tokens = await this.generateTokens(user.id, user.email, role.name, tenant.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        role: role.name,
      },
      tokens,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { role: true, tenant: true },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is disabled');
    }

    this.logger.logEvent('user_login', {
      tenantId: user.tenantId,
      userId: user.id,
      email: user.email,
    });

    const tokens = await this.generateTokens(user.id, user.email, user.role.name, user.tenantId);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
        role: user.role.name,
      },
      tokens,
    };
  }

  async generateTokens(userId: string, email: string, role: string, tenantId: string) {
    const payload = { sub: userId, email, role, tenantId };
    const accessToken = await this.jwtService.signAsync(payload, { expiresIn: '15m' });
    const refreshToken = await this.jwtService.signAsync({ sub: userId }, { expiresIn: '7d' });

    const tokenHash = await argon2.hash(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    });

    return { accessToken, refreshToken };
  }

  async revokeToken(accessToken: string, userId: string) {
    try {
      const decoded = this.jwtService.decode(accessToken) as any;
      if (decoded && decoded.jti) {
        await this.redis.blacklistToken(decoded.jti, 86400);
      } else {
        await this.redis.blacklistToken(accessToken, 86400);
      }

      await this.prisma.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });

      this.logger.logEvent('user_logout', { userId });
      return { status: 'success', message: 'Token revoked successfully' };
    } catch (e) {
      return { status: 'success', message: 'Logged out' };
    }
  }

  async verifyToken(token: string) {
    const isBlacklisted = await this.redis.isTokenBlacklisted(token);
    if (isBlacklisted) {
      throw new UnauthorizedException('Token has been revoked');
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);
      return payload;
    } catch (e) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async getUsers(tenantId?: string, pagination?: PaginationQuery): Promise<PaginatedResult<any>> {
    const { limit, skip, cursor } = parsePaginationParams(pagination);
    const where: any = tenantId ? { tenantId } : {};

    const totalCount = await this.prisma.user.count({ where });

    const queryArgs: any = {
      where,
      take: limit + 1,
      select: {
        id: true,
        email: true,
        name: true,
        tenantId: true,
        roleId: true,
        isActive: true,
        createdAt: true,
        tenant: { select: { id: true, name: true, slug: true } },
        role: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    };

    if (cursor) {
      queryArgs.cursor = { id: cursor };
      queryArgs.skip = 1;
    } else if (skip) {
      queryArgs.skip = skip;
    }

    const items = await this.prisma.user.findMany(queryArgs);
    return buildPaginatedResult(items, limit, (item) => item.id, totalCount, skip);
  }

  async getTenants(pagination?: PaginationQuery): Promise<PaginatedResult<any>> {
    const { limit, skip, cursor } = parsePaginationParams(pagination);
    const totalCount = await this.prisma.tenant.count();

    const queryArgs: any = {
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    };

    if (cursor) {
      queryArgs.cursor = { id: cursor };
      queryArgs.skip = 1;
    } else if (skip) {
      queryArgs.skip = skip;
    }

    const items = await this.prisma.tenant.findMany(queryArgs);
    return buildPaginatedResult(items, limit, (item) => item.id, totalCount, skip);
  }
}
