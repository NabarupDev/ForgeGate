import { Module, Controller, Get } from '@nestjs/common';

@Controller('notifications')
export class NotificationController {
  @Get('health')
  health() {
    return { service: 'notification-service', workerQueue: 'rabbitmq', status: 'ok' };
  }
}

@Module({
  controllers: [NotificationController],
})
export class AppModule {}
