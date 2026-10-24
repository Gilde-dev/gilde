import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExecutionModule } from '../execution/execution.module.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { RepoModule } from '../repo/repo.module.js';
import { Repo } from '../repo/repo.entity.js';
import { RunModule } from '../run/run.module.js';
import { JobRun } from '../run/run.entity.js';

import { DispatchController } from './dispatch.controller.js';
import { DispatcherService } from './dispatcher.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Job,
            Repo,
            Project,
            JobRun
        ]),
        ExecutionModule,
        RepoModule,
        RunModule
    ],
    controllers: [
        DispatchController
    ],
    providers: [
        DispatcherService
    ]
})
export class DispatchModule { }
