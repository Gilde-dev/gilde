import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { PrReviewOverrideSchema, type PrReviewDto, type PrReviewOverrideDto } from './pr-review.dto.js';
import { ReviewOverrideService } from './review-override.service.js';

/** Human-only: a persisted non-bot user with a JWT (never an API key) overrides an automatic review decision. */
@Controller('/v1/jobs')
export class ReviewOverrideController {
    constructor(private readonly service: ReviewOverrideService) { }

    @Post(':id/review-override')
    @UseGuards(JwtHumanGuard)
    @HttpCode(200)
    override(
        @CurrentUser() user: AuthUser | null,
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(PrReviewOverrideSchema)) dto: PrReviewOverrideDto,
    ): Promise<PrReviewDto> {
        return this.service.override(user ?? undefined, id, dto);
    }
}
