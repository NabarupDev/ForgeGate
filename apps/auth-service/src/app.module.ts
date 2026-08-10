import { Module, Controller, Post, Body, Get, Query, Headers, UseGuards, Req } from '@nestjs/common';
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
