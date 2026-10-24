import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { Job } from '../job/job.entity.js';
import { ProjectModule } from '../project/project.module.js';
import { RepoModule } from '../repo/repo.module.js';
import { JobRun } from '../run/run.entity.js';

import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Job,
            JobRun
        ]),
        ProjectModule,
        RepoModule
    ],
    controllers: [
        MetricsController
    ],
    providers: [
        MetricsService
    ]
})
export class MetricsModule { }
