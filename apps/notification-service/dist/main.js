"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const logger_1 = require("@forgegate/logger");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const logger = new logger_1.StructuredLogger('Notification-Service');
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { logger });
    const port = process.env.NOTIFICATION_SERVICE_PORT || 3003;
    await app.listen(port);
    logger.log(`Notification Consumer Microservice operational on port ${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map