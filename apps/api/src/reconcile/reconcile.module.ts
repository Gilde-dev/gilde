import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GitHubModule } from '../github/github.module.js';
import { JobEventsModule } from '../job/job-events.module.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';

import { ReconcileController } from './reconcile.controller.js';
import { ReconcilerService } from './reconciler.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Job, Repo]), GitHubModule, JobEventsModule],
    controllers: [ReconcileController],
    providers: [ReconcilerService],
})
export class ReconcileModule { }
