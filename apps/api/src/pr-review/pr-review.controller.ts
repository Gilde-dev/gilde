import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { PrReviewHistoryQuerySchema, type PrReviewHistoryQuery, type PrReviewPageDto } from './pr-review.dto.js';
import { PrReviewService } from './pr-review.service.js';

/** The automatic review history of a job, read-only. Ordinary JWT / API-key auth. */
@Controller('/v1/jobs')
export class PrReviewController {
    constructor(private readonly service: PrReviewService) { }

    @Get(':id/reviews')
    history(
        @Param('id', ParseUUIDPipe) id: string,
        @Query(new ZodValidationPipe(PrReviewHistoryQuerySchema)) q: PrReviewHistoryQuery,
    ): Promise<PrReviewPageDto> {
        return this.service.listForJob(id, q);
    }
}
