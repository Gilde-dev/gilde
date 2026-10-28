import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    ListIntakeQuerySchema,
    type IntakeItemDetailResponseDto,
    type IntakeItemResponseDto,
    type IntakeSweepResultDto,
    type ListIntakeQueryDto,
} from './intake.dto.js';
import { IntakeService } from './intake.service.js';

@Controller('/v1')
export class IntakeController {

    constructor(private readonly intakeService: IntakeService) { }

    @Get('projects/:id/intake')
    list(
        @Param('id', ParseUUIDPipe) projectId: string,
        @Query(new ZodValidationPipe(ListIntakeQuerySchema)) query: ListIntakeQueryDto,
    ): Promise<IntakeItemResponseDto[]> {
        return this.intakeService.list(projectId, query);
    }

    @Get('intake/:id')
    getById(@Param('id', ParseUUIDPipe) id: string): Promise<IntakeItemDetailResponseDto> {
        return this.intakeService.getById(id);
    }

    /** Verified humans only: an interactive JWT of a persisted, non-bot account. */
    @Post('intake/sweep')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    sweep(@CurrentUser() user: AuthUser | null): Promise<IntakeSweepResultDto> {
        return this.intakeService.sweepAs(user ?? undefined);
    }

    @Post('intake/:id/ignore')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    ignore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<IntakeItemDetailResponseDto> {
        return this.intakeService.ignore(id, user ?? undefined);
    }

    @Post('intake/:id/retry')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    retry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<IntakeItemDetailResponseDto> {
        return this.intakeService.retry(id, user ?? undefined);
    }
}
