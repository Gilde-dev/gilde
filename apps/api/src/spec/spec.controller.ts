import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    ApproveSpecSchema,
    CreateSpecSchema,
    ListSpecsQuerySchema,
    SaveSpecVersionSchema,
    type ApproveSpecDto,
    type CreateSpecDto,
    type ListSpecsQueryDto,
    type SaveSpecVersionDto,
    type SpecDetailResponseDto,
    type SpecResponseDto,
} from './spec.dto.js';
import { SpecService } from './spec.service.js';

/** The actor of every write is the authenticated request's user, never a body field. */
@Controller('/v1')
export class SpecController {

    constructor(private readonly specService: SpecService) { }

    @Get('projects/:id/specs')
    list(
        @Param('id', ParseUUIDPipe) projectId: string,
        @Query(new ZodValidationPipe(ListSpecsQuerySchema)) query: ListSpecsQueryDto,
    ): Promise<SpecResponseDto[]> {
        return this.specService.list(projectId, query);
    }

    @Post('projects/:id/specs')
    create(
        @Param('id', ParseUUIDPipe) projectId: string,
        @Body(new ZodValidationPipe(CreateSpecSchema)) dto: CreateSpecDto,
        @CurrentUser() user: AuthUser | null,
    ): Promise<SpecDetailResponseDto> {
        return this.specService.create(projectId, dto, user);
    }

    @Get('specs/:id')
    getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<SpecDetailResponseDto> {
        return this.specService.getDetail(id, user);
    }

    @Post('specs/:id/versions')
    saveVersion(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(SaveSpecVersionSchema)) dto: SaveSpecVersionDto,
        @CurrentUser() user: AuthUser | null,
    ): Promise<SpecDetailResponseDto> {
        return this.specService.saveVersion(id, dto, user);
    }

    /** Verified humans only: an interactive JWT of a persisted, non-bot account. */
    @Post('specs/:id/approve')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    approve(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(ApproveSpecSchema)) dto: ApproveSpecDto,
        @CurrentUser() user: AuthUser | null,
    ): Promise<SpecDetailResponseDto> {
        return this.specService.approve(id, dto, user ?? undefined);
    }

    /** Verified humans only. */
    @Post('specs/:id/archive')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<SpecDetailResponseDto> {
        return this.specService.archive(id, user ?? undefined);
    }

    /** Verified humans only. */
    @Post('specs/:id/unarchive')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    unarchive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<SpecDetailResponseDto> {
        return this.specService.unarchive(id, user ?? undefined);
    }
}
