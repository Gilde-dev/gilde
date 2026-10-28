import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BudgetModule } from '../budget/budget.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { ExecutorModule } from '../executor/executor.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { Feature } from '../feature/feature.entity.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { HistoryModule } from '../memory/history/history.module.js';
import { Project } from '../project/project.entity.js';
import { RepoModule } from '../repo/repo.module.js';
import { Repo } from '../repo/repo.entity.js';
import { User } from '../user/user.entity.js';
import { RunModule } from '../run/run.module.js';
import { JobRevision } from '../revision/revision.entity.js';
import { JobRun } from '../run/run.entity.js';

import { DispatchController } from './dispatch.controller.js';
import { DispatcherService } from './dispatcher.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Job,
            JobDependency,
            Repo,
            Project,
            JobRun,
            Feature,
            JobRevision,
            User
        ]),
        ExecutionModule,
        ExecutorModule,
        HistoryModule,
        RepoModule,
        RunModule,
        NotificationModule,
        BudgetModule
    ],
    controllers: [
        DispatchController
    ],
    providers: [
        DispatcherService
    ],
    exports: [
        DispatcherService
    ]
})
export class DispatchModule { }
