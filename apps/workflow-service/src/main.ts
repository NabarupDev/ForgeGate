import { NestFactory } from '@nestjs/core';
import { StructuredLogger } from '@forgegate/logger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new StructuredLogger('Workflow-Service');
  const app = await NestFactory.create(AppModule, { logger });

  const port = process.env.WORKFLOW_SERVICE_PORT || 3002;
  await app.listen(port);
  logger.log(`Workflow Engine Microservice operational on port ${port}`);
}

bootstrap();
