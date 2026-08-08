import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { StructuredLogger } from '@forgegate/logger';
import { AllExceptionsFilter } from '@forgegate/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new StructuredLogger('Notification-Service');
  const app = await NestFactory.create(AppModule, { logger });

  (app.getHttpAdapter().getInstance() as any)?.disable?.('x-powered-by');
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = process.env.NOTIFICATION_SERVICE_PORT || 3003;
  await app.listen(port);
  logger.log(`Notification Consumer Microservice operational on port ${port}`);
}

bootstrap();
