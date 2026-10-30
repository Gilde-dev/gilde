import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentModule } from '../agent/agent.module.js';
import { AgentRunModule } from '../agent-run/agent-run.module.js';
import { BudgetModule } from '../budget/budget.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { Feature } from '../feature/feature.entity.js';
import { GitHubModule } from '../github/github.module.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';
import { LessonModule } from '../lesson/lesson.module.js';
import { NotificationModule } from '../notification/notification.module.js';

import { UserModule } from '../user/user.module.js';
import { PassportModule } from '@nestjs/passport';

import { ReviewOverrideController } from './review-override.controller.js';
import { ReviewOverrideService } from './review-override.service.js';
import { PrReviewController } from './pr-review.controller.js';
import { PrReview } from './pr-review.entity.js';
import { AutoReviewGateService } from './auto-review-gate.service.js';
import { PrReviewService } from './pr-review.service.js';
import { ReviewExecutionService } from './review-execution.service.js';
import { ReviewInputService } from './review-input.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([PrReview, Job, Feature, Repo, Project, JobRun]), GitHubModule, AgentModule, AgentRunModule, BudgetModule, UsageModule, LessonModule, NotificationModule, UserModule, PassportModule.register({})],
    controllers: [PrReviewController, ReviewOverrideController],
    providers: [PrReviewService, ReviewOverrideService, ReviewInputService, ReviewExecutionService, AutoReviewGateService],
    exports: [PrReviewService, ReviewOverrideService, ReviewInputService, ReviewExecutionService, AutoReviewGateService],
})
export class PrReviewModule { }
