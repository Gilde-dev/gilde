import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Feedback } from '../feedback/feedback.entity.js';
import { Job } from '../job/job.entity.js';
import { JobModule } from '../job/job.module.js';
import { ProjectModule } from '../project/project.module.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { SkillModule } from '../skill/skill.module.js';
import { LessonController } from './lesson.controller.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonService } from './lesson.service.js';
import { LESSON_JOB_HOOK } from './lesson-hook.js';
import { LessonCollectorService } from './lesson-collector.service.js';
import { LessonSource } from './lesson-source.entity.js';

@Module({
    imports: [TypeOrmModule.forFeature([Lesson, LessonSource, JobRun, Feedback, Job, Repo]), JobModule, ProjectModule, SkillModule],
    controllers: [LessonController],
    providers: [LessonMapper, LessonService, LessonCollectorService, { provide: LESSON_JOB_HOOK, useExisting: LessonService }],
    exports: [LessonService],
})
export class LessonModule { }
