import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JobEventsModule } from '../job/job-events.module.js';
import { Job } from '../job/job.entity.js';
import { FeedbackModule } from '../feedback/feedback.module.js';
import { Project } from '../project/project.entity.js';
import { RepoModule } from '../repo/repo.module.js';
import { JobRun } from '../run/run.entity.js';

import { WebhookDelivery } from './webhook-delivery.entity.js';
import { WebhookController } from './webhook.controller.js';
import { WebhookService } from './webhook.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([Job, JobRun, Project, WebhookDelivery]),
        RepoModule,
        FeedbackModule,
        JobEventsModule,
    ],
    controllers: [WebhookController],
    providers: [WebhookService],
})
export class WebhookModule { }
