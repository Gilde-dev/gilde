import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { Feature } from '../feature/feature.entity.js';
import { FeedbackModule } from '../feedback/feedback.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { HistoryModule } from '../memory/history/history.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { RepoModule } from '../repo/repo.module.js';
import { RunModule } from '../run/run.module.js';

import { JobDependency } from './job-dependency.entity.js';
import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { JobPromptService } from './job-prompt.service.js';
import { JobService } from './job.service.js';
import { JobController } from './job.controller.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Job,
            JobDependency,
            Feature,
            Repo,
            JobRevision
        ]),
        ExecutionModule,
        HistoryModule,
        RepoModule,
        RunModule,
        FeedbackModule,
        NotificationModule
    ],
    controllers: [
        JobController
    ],
    providers: [
        JobMapper,
        JobPromptService,
        JobService
    ],
    exports: [
        JobService
    ]
})
export class JobModule { }
