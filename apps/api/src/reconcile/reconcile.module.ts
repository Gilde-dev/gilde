import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GitHubModule } from '../github/github.module.js';
import { JobEventsModule } from '../job/job-events.module.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';
import { PassportModule } from '@nestjs/passport';
import { UserModule } from '../user/user.module.js';
import { Repo } from '../repo/repo.entity.js';

import { ReconcileController } from './reconcile.controller.js';
import { ReconcilerService } from './reconciler.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Job, Repo, Project, JobRun]), GitHubModule, JobEventsModule, UserModule, PassportModule.register({})],
    controllers: [ReconcileController],
    providers: [ReconcilerService],
})
export class ReconcileModule { }
