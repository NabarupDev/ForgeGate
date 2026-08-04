import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { StructuredLogger } from '@forgegate/logger';
import { TransformInterceptor, AllExceptionsFilter } from '@forgegate/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new StructuredLogger('API-Gateway');
  const app = await NestFactory.create(AppModule, { logger });

  const apiPrefix = 'api/v1';
  app.setGlobalPrefix(apiPrefix);
  app.enableCors();
  app.enableShutdownHooks();

  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ForgeGate - API Gateway')
    .setDescription('Distributed Backend Workflow Platform - Gateway Documentation')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`API Gateway operational on port ${port}`);
}

bootstrap();
