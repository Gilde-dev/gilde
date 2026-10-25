import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.dto.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    ListLessonsQuerySchema,
    MergeLessonsSchema,
    UpdateLessonSchema,
    type CollectResultDto,
    type LessonResponseDto,
    type ListLessonsQuery,
    type MergeLessonsDto,
    type UpdateLessonDto,
} from './lesson.dto.js';
import { LessonCollectorService } from './lesson-collector.service.js';
import { LessonService } from './lesson.service.js';

@Controller('/v1/lessons')
export class LessonController {

    constructor(
        private readonly lessonService: LessonService,
        private readonly collector: LessonCollectorService,
    ) { }

    @Get()
    list(@Query(new ZodValidationPipe(ListLessonsQuerySchema)) q: ListLessonsQuery): Promise<LessonResponseDto[]> {
        return this.lessonService.list(q);
    }

    @Post('collect')
    @HttpCode(200)
    collect(): Promise<CollectResultDto> {
        return this.collector.collect();
    }

    @Post('merge')
    @HttpCode(200)
    merge(@Body(new ZodValidationPipe(MergeLessonsSchema)) dto: MergeLessonsDto): Promise<LessonResponseDto> {
        return this.lessonService.merge(dto);
    }

    @Get(':id')
    getById(@Param('id', ParseUUIDPipe) id: string): Promise<LessonResponseDto> {
        return this.lessonService.getById(id);
    }

    @Patch(':id')
    update(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(UpdateLessonSchema)) dto: UpdateLessonDto,
    ): Promise<LessonResponseDto> {
        return this.lessonService.update(id, dto);
    }

    @Post(':id/approve')
    @HttpCode(200)
    approve(@Param('id', ParseUUIDPipe) id: string): Promise<LessonResponseDto> {
        return this.lessonService.approve(id);
    }

    @Post(':id/reject')
    @HttpCode(200)
    reject(@Param('id', ParseUUIDPipe) id: string): Promise<LessonResponseDto> {
        return this.lessonService.reject(id);
    }

    @Post(':id/apply')
    @HttpCode(200)
    apply(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<LessonResponseDto> {
        return this.lessonService.apply(id, user);
    }

    @Post(':id/mark-applied')
    @HttpCode(200)
    markApplied(@Param('id', ParseUUIDPipe) id: string): Promise<LessonResponseDto> {
        return this.lessonService.markApplied(id);
    }

    @Post(':id/reopen')
    @HttpCode(200)
    reopen(@Param('id', ParseUUIDPipe) id: string): Promise<LessonResponseDto> {
        return this.lessonService.reopen(id);
    }
}
