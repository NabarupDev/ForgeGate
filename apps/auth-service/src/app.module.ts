import { Module, Controller, Post, Body, Get, Query, Headers } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { AuthService, RegisterDto, LoginDto } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.authService.login(body);
  }

  @Post('logout')
  async logout(@Headers('authorization') authHeader: string, @Body() body: { userId: string }) {
    const token = authHeader ? authHeader.replace('Bearer ', '') : '';
    return this.authService.revokeToken(token, body.userId);
  }

  @Post('verify')
  async verify(@Body() body: { token: string }) {
    return this.authService.verifyToken(body.token);
  }

  @Get('users')
  async getUsers(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.authService.getUsers(tenantId, { limit, skip, cursor });
  }

  @Get('tenants')
  async getTenants(
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.authService.getTenants({ limit, skip, cursor });
  }

  @Get('audit-logs')
  async getAuditLogs(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.authService.getAuditLogs(tenantId, { limit, skip, cursor });
  }

  @Post('users/role')
  async changeUserRole(@Body() body: { targetUserId: string; roleName: string; actorUserId?: string; tenantId?: string }) {
    return this.authService.changeUserRole(body.targetUserId, body.roleName, body.actorUserId, body.tenantId);
  }

  @Post('roles/permissions')
  async updateRolePermissions(@Body() body: { roleName: string; permissions: string[]; actorUserId?: string; tenantId?: string }) {
    return this.authService.updateRolePermissions(body.roleName, body.permissions, body.actorUserId, body.tenantId);
  }

  @Post('tenants/update')
  async updateTenant(@Body() body: { tenantId: string; updates: { name?: string; slug?: string; isActive?: boolean }; actorUserId?: string }) {
    return this.authService.updateTenant(body.tenantId, body.updates, body.actorUserId);
  }

  @Post('apikeys')
  async createApiKey(@Body() body: { tenantId: string; userId: string; name: string }) {
    return this.authService.createApiKey(body.tenantId, body.userId, body.name);
  }

  @Get('health')
  health() {
    return { service: 'auth-service', status: 'ok', timestamp: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super-secret-forgegate-key',
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [PrismaService, RedisService, AuthService],
  exports: [AuthService, PrismaService, RedisService],
})
export class AppModule {}
