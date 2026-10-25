import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationController } from './notification.controller.js';
import { Notification } from './notification.entity.js';
import { NotificationMapper } from './notification.mapper.js';
import { NotificationService } from './notification.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Notification])],
    controllers: [NotificationController],
    providers: [NotificationService, NotificationMapper],
    exports: [NotificationService],
})
export class NotificationModule { }
