import { Module, Controller, Post, Body, Get } from '@nestjs/common';

@Controller('auth')
export class AuthController {
  @Post('register')
  register(@Body() body: any) {
    return { status: 'registered', email: body.email };
  }

  @Post('login')
  login(@Body() body: any) {
    return { accessToken: 'jwt-access-token-placeholder', refreshToken: 'jwt-refresh-token-placeholder' };
  }

  @Get('health')
  health() {
    return { service: 'auth-service', status: 'ok' };
  }
}

@Module({
  controllers: [AuthController],
})
export class AppModule {}
