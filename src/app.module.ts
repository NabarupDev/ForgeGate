import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration, { configValidationSchema } from './config/configuration';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './modules/audit/audit.module';
import { BillingModule } from './modules/billing/billing.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: configValidationSchema,
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AuditModule,
    BillingModule,
  ],
})
export class AppModule {}
