import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JobModule } from './job.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { LessonModule } from '../lesson/lesson.module.js';
import { GitHubModule } from '../github/github.module.js';
import { Repo } from '../repo/repo.entity.js';
import { UserModule } from '../user/user.module.js';
import { RepoModule } from '../repo/repo.module.js';
import { Project } from '../project/project.entity.js';
import { RevisionModule } from '../revision/revision.module.js';
import { JobRun } from '../run/run.entity.js';

import { Job } from './job.entity.js';
import { JobSendBackController } from './job-send-back.controller.js';
import { MergeConflictService } from './merge-conflict.service.js';
import { JobEventsService } from './job-events.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Job, JobRun, Project, Repo]), GitHubModule, UserModule, PassportModule.register({}), JobModule, LessonModule, RepoModule, RevisionModule, NotificationModule],
    controllers: [JobSendBackController],
    providers: [JobEventsService, MergeConflictService],
    exports: [JobEventsService, MergeConflictService],
})
export class JobEventsModule { }
