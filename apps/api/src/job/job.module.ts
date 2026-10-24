import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

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
        RunModule
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
