import { Module, Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationWorker } from './notification.worker';

@Controller('notifications')
export class NotificationController {
  @Get('health')
  health() {
    return { service: 'notification-service', workerQueue: 'BullMQ/Redis', status: 'ok', timestamp: new Date().toISOString() };
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [NotificationController],
  providers: [NotificationWorker],
})
export class AppModule {}
