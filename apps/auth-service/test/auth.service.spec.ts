import { AuthService } from '../src/auth.service';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';

jest.mock('argon2');
const mockedArgon2 = argon2 as jest.Mocked<typeof argon2>;

describe('AuthService (Current Behavior Regression Tests)', () => {
  let service: AuthService;
  let prismaMock: any;
  let redisMock: any;
  let jwtServiceMock: any;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaMock = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      tenant: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      role: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    redisMock = {
      blacklistToken: jest.fn(),
      isTokenBlacklisted: jest.fn(),
    };

    jwtServiceMock = {
      signAsync: jest.fn().mockResolvedValue('jwt-mock-token'),
      verifyAsync: jest.fn(),
      decode: jest.fn(),
    };

    service = new AuthService(prismaMock as any, redisMock as any, jwtServiceMock as any);
  });

  describe('register', () => {
    it('should throw BadRequestException if email already exists', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'existing-user' });

      await expect(
        service.register({ email: 'duplicate@example.com', password: 'pass', name: 'User' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should register new user, create tenant/role if missing, and return tokens', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.tenant.findUnique.mockResolvedValue(null);
      prismaMock.tenant.create.mockResolvedValue({
        id: 't-new',
        name: 'Default Tenant',
        slug: 'default-tenant',
      });
      prismaMock.role.findUnique.mockResolvedValue(null);
      prismaMock.role.create.mockResolvedValue({ id: 'r-user', name: 'user' });

      mockedArgon2.hash.mockResolvedValue('argon2-hashed-pass');

      const mockUser = {
        id: 'u-1',
        email: 'new@example.com',
        name: 'New User',
        tenantId: 't-new',
        roleId: 'r-user',
        tenant: { id: 't-new', name: 'Default Tenant', slug: 'default-tenant' },
        role: { id: 'r-user', name: 'user' },
      };
      prismaMock.user.create.mockResolvedValue(mockUser);
      prismaMock.refreshToken.create.mockResolvedValue({});

      const result = await service.register({
        email: 'new@example.com',
        password: 'Password123',
        name: 'New User',
      });

      expect(result.user.email).toBe('new@example.com');
      expect(result.tokens).toEqual({
        accessToken: 'jwt-mock-token',
        refreshToken: 'jwt-mock-token',
      });
    });
  });

  describe('login', () => {
    it('should throw UnauthorizedException for non-existent email', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'unknown@example.com', password: 'pass' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for invalid password', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'test@example.com',
        passwordHash: 'argon-hash',
        role: { name: 'user' },
        tenant: { id: 't-1' },
      });
      mockedArgon2.verify.mockResolvedValue(false);

      await expect(
        service.login({ email: 'test@example.com', password: 'wrong-password' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should login successfully with valid credentials', async () => {
      const mockUser = {
        id: 'u-1',
        email: 'valid@example.com',
        passwordHash: 'argon-hash',
        name: 'Valid User',
        isActive: true,
        role: { name: 'user' },
        tenant: { id: 't-1', name: 'Tenant 1', slug: 'tenant-1' },
      };
      prismaMock.user.findUnique.mockResolvedValue(mockUser);
      mockedArgon2.verify.mockResolvedValue(true);
      prismaMock.refreshToken.create.mockResolvedValue({});

      const res = await service.login({ email: 'valid@example.com', password: 'correct' });

      expect(res.user.email).toBe('valid@example.com');
      expect(res.tokens.accessToken).toBe('jwt-mock-token');
    });
  });

  describe('verifyToken', () => {
    it('should throw UnauthorizedException if token is blacklisted', async () => {
      redisMock.isTokenBlacklisted.mockResolvedValue(true);

      await expect(service.verifyToken('revoked-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should return payload for valid non-blacklisted token', async () => {
      redisMock.isTokenBlacklisted.mockResolvedValue(false);
      const mockPayload = { sub: 'u-1', email: 'user@example.com', role: 'user', tenantId: 't-1' };
      jwtServiceMock.verifyAsync.mockResolvedValue(mockPayload);

      const payload = await service.verifyToken('valid-jwt-token');

      expect(payload).toEqual(mockPayload);
    });
  });
});
