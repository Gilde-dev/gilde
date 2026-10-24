import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LessonModule } from '../lesson/lesson.module.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';

import { Job } from './job.entity.js';
import { JobEventsService } from './job-events.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Job, JobRun, Project]), LessonModule],
    providers: [JobEventsService],
    exports: [JobEventsService],
})
export class JobEventsModule { }
