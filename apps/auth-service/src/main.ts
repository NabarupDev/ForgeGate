import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { StructuredLogger } from '@forgegate/logger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new StructuredLogger('Auth-Service');
  const app = await NestFactory.create(AppModule, { logger });

  const port = process.env.AUTH_SERVICE_PORT || 3001;
  await app.listen(port);
  logger.log(`Auth Microservice operational on port ${port}`);
}

bootstrap();
