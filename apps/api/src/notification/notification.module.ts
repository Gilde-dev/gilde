import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Feature } from '../feature/feature.entity.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { NotificationCaptureService } from './notification-capture.service.js';
import { NotificationController } from './notification.controller.js';
import { Notification } from './notification.entity.js';
import { NotificationMapper } from './notification.mapper.js';
import { NotificationService } from './notification.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Notification, Repo, Job, Feature, JobRun])],
    controllers: [NotificationController],
    providers: [NotificationService, NotificationMapper, NotificationCaptureService],
    exports: [NotificationService, NotificationCaptureService],
})
export class NotificationModule { }
