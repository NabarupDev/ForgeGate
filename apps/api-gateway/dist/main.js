"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const logger_1 = require("@forgegate/logger");
const common_2 = require("@forgegate/common");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const logger = new logger_1.StructuredLogger('API-Gateway');
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { logger });
    const apiPrefix = 'api/v1';
    app.setGlobalPrefix(apiPrefix);
    app.enableCors();
    app.enableShutdownHooks();
    app.useGlobalInterceptors(new common_2.TransformInterceptor());
    app.useGlobalFilters(new common_2.AllExceptionsFilter());
    app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, transform: true }));
    const swaggerConfig = new swagger_1.DocumentBuilder()
        .setTitle('ForgeGate - API Gateway')
        .setDescription('Distributed Backend Workflow Platform - Gateway Documentation')
        .setVersion('1.0.0')
        .addBearerAuth()
        .build();
    const document = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
    swagger_1.SwaggerModule.setup(`${apiPrefix}/docs`, app, document);
    const port = process.env.PORT || 3000;
    await app.listen(port);
    logger.log(`API Gateway operational on port ${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map