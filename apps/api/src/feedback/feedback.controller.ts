import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { ListFeedbackQuerySchema, type FeedbackResponseDto, type ListFeedbackQuery } from './feedback.dto.js';
import { FeedbackService } from './feedback.service.js';

@Controller('/v1/feedback')
export class FeedbackController {

    constructor(private readonly feedbackService: FeedbackService) { }

    @Get()
    list(@Query(new ZodValidationPipe(ListFeedbackQuerySchema)) q: ListFeedbackQuery): Promise<FeedbackResponseDto[]> {
        return this.feedbackService.list(q);
    }

}
