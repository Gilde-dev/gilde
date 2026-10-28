import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { ListLessonPatternsQuerySchema, type LessonPatternsResponseDto, type ListLessonPatternsQuery } from './lesson.dto.js';
import { LessonPatternService } from './lesson-pattern.service.js';

@Controller('/v1/projects')
export class LessonPatternController {

    constructor(private readonly patterns: LessonPatternService) { }

    @Get(':id/lessons/patterns')
    list(
        @Param('id', ParseUUIDPipe) id: string,
        @Query(new ZodValidationPipe(ListLessonPatternsQuerySchema)) q: ListLessonPatternsQuery,
    ): Promise<LessonPatternsResponseDto> {
        return this.patterns.list(id, q);
    }
}
