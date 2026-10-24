import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';

import { Job } from './job.entity.js';
import { JobEventsService } from './job-events.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Job, JobRun, Project])],
    providers: [JobEventsService],
    exports: [JobEventsService],
})
export class JobEventsModule { }
