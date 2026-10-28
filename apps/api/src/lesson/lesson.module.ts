import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Feedback } from '../feedback/feedback.entity.js';
import { Job } from '../job/job.entity.js';
import { JobModule } from '../job/job.module.js';
import { ProjectModule } from '../project/project.module.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { RepoModule } from '../repo/repo.module.js';
import { UserModule } from '../user/user.module.js';
import { SkillModule } from '../skill/skill.module.js';
import { LessonController } from './lesson.controller.js';
import { LessonPatternController } from './lesson-pattern.controller.js';
import { LessonPatternService } from './lesson-pattern.service.js';
import { LessonSkillProposalService } from './lesson-skill-proposal.service.js';
import { LessonEmbedding } from './lesson-embedding.entity.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonService } from './lesson.service.js';
import { LESSON_JOB_HOOK } from './lesson-hook.js';
import { LessonCollectorService } from './lesson-collector.service.js';
import { LessonSource } from './lesson-source.entity.js';

@Module({
    imports: [PassportModule.register({}), TypeOrmModule.forFeature([Lesson, LessonSource, LessonEmbedding, JobRun, Feedback, Job, Repo]), JobModule, ProjectModule, SkillModule, RepoModule, UserModule],
    controllers: [LessonController, LessonPatternController],
    providers: [LessonMapper, LessonService, LessonPatternService, LessonSkillProposalService, LessonCollectorService, { provide: LESSON_JOB_HOOK, useExisting: LessonService }],
    exports: [LessonService, LessonPatternService],
})
export class LessonModule { }
