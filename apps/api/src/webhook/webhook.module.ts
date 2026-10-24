import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { RepoModule } from '../repo/repo.module.js';
import { JobRun } from '../run/run.entity.js';

import { WebhookController } from './webhook.controller.js';
import { WebhookService } from './webhook.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([Job, JobRun, Project]),
        RepoModule,
    ],
    controllers: [WebhookController],
    providers: [WebhookService],
})
export class WebhookModule { }
