import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { StructuredLogger } from '@forgegate/logger';
import { AllExceptionsFilter, applyHttpHardening } from '@forgegate/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new StructuredLogger('Workflow-Service');
  const app = await NestFactory.create(AppModule, { logger });

  app.enableShutdownHooks();
  applyHttpHardening(app);
  app.useGlobalFilters(new AllExceptionsFilter());

  process.on('SIGTERM', () => {
    logger.log('SIGTERM signal received. Initiating Workflow-Service graceful shutdown sequence...');
  });

  process.on('SIGINT', () => {
    logger.log('SIGINT signal received. Initiating Workflow-Service graceful shutdown sequence...');
  });

  const port = process.env.WORKFLOW_SERVICE_PORT || 3002;
  await app.listen(port);
  logger.log(`Workflow Engine Microservice operational on port ${port}`);
}

bootstrap();
