import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Job } from '../job/job.entity.js';

import { PrReviewController } from './pr-review.controller.js';
import { PrReview } from './pr-review.entity.js';
import { PrReviewService } from './pr-review.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([PrReview, Job])],
    controllers: [PrReviewController],
    providers: [PrReviewService],
    exports: [PrReviewService],
})
export class PrReviewModule { }
