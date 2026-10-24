import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { FeedbackModule } from '../feedback/feedback.module.js';
import { RepoModule } from '../repo/repo.module.js';
import { RunModule } from '../run/run.module.js';

import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { JobService } from './job.service.js';
import { JobController } from './job.controller.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Job
        ]),
        RepoModule,
        RunModule,
        FeedbackModule
    ],
    controllers: [
        JobController
    ],
    providers: [
        JobMapper,
        JobService
    ],
    exports: [
    ]
})
export class JobModule { }
