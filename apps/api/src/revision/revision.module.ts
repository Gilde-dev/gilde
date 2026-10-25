import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { JobModule } from '../job/job.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { JobRun } from '../run/run.entity.js';

import { ProposalService } from './proposal.service.js';
import { RevisionController } from './revision.controller.js';
import { JobRevision } from './revision.entity.js';
import { RevisionService } from './revision.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([JobRevision, Job, JobRun, JobDependency]), JobModule, NotificationModule],
    controllers: [RevisionController],
    providers: [RevisionService, ProposalService],
    exports: [ProposalService, RevisionService],
})
export class RevisionModule { }
