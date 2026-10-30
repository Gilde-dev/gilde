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

import { PrReviewController } from './pr-review.controller.js';
import { PrReview } from './pr-review.entity.js';
import { PrReviewService } from './pr-review.service.js';
import { ReviewExecutionService } from './review-execution.service.js';
import { ReviewInputService } from './review-input.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([PrReview, Job, Feature, Repo]), GitHubModule, AgentModule, AgentRunModule, BudgetModule, UsageModule],
    controllers: [PrReviewController],
    providers: [PrReviewService, ReviewInputService, ReviewExecutionService],
    exports: [PrReviewService, ReviewInputService, ReviewExecutionService],
})
export class PrReviewModule { }
