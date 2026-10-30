import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Feature } from '../feature/feature.entity.js';
import { GitHubModule } from '../github/github.module.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';

import { PrReviewController } from './pr-review.controller.js';
import { PrReview } from './pr-review.entity.js';
import { PrReviewService } from './pr-review.service.js';
import { ReviewInputService } from './review-input.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([PrReview, Job, Feature, Repo]), GitHubModule],
    controllers: [PrReviewController],
    providers: [PrReviewService, ReviewInputService],
    exports: [PrReviewService, ReviewInputService],
})
export class PrReviewModule { }
