import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    CreateExecutorSchema,
    ReplaceExecutorSchema,
    ReplaceExecutorTokenSchema,
    type CreateExecutorDto,
    type ExecutorResponseDto,
    type ReplaceExecutorDto,
    type ReplaceExecutorTokenDto,
} from './executor.dto.js';
import { ExecutorService } from './executor.service.js';

/** The current user's own executors. Writes are for verified humans only (interactive JWT, no API keys, bots or the scout). */
@Controller('/v1/executors')
export class ExecutorController {
    constructor(private readonly executors: ExecutorService) { }

    @Get()
    list(@CurrentUser() user: AuthUser | null): Promise<ExecutorResponseDto[]> {
        return this.executors.list(user);
    }

    @Post()
    @UseGuards(JwtHumanGuard)
    create(
        @CurrentUser() user: AuthUser | null,
        @Body(new ZodValidationPipe(CreateExecutorSchema)) dto: CreateExecutorDto,
    ): Promise<ExecutorResponseDto> {
        return this.executors.create(user, dto);
    }

    @Get(':id')
    get(@CurrentUser() user: AuthUser | null, @Param('id', ParseUUIDPipe) id: string): Promise<ExecutorResponseDto> {
        return this.executors.get(user, id);
    }

    @Put(':id')
    @UseGuards(JwtHumanGuard)
    replace(
        @CurrentUser() user: AuthUser | null,
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(ReplaceExecutorSchema)) dto: ReplaceExecutorDto,
    ): Promise<ExecutorResponseDto> {
        return this.executors.replace(user, id, dto);
    }

    @Put(':id/token')
    @HttpCode(204)
    @UseGuards(JwtHumanGuard)
    replaceToken(
        @CurrentUser() user: AuthUser | null,
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(ReplaceExecutorTokenSchema)) dto: ReplaceExecutorTokenDto,
    ): Promise<void> {
        return this.executors.replaceToken(user, id, dto);
    }

    @Delete(':id')
    @HttpCode(204)
    @UseGuards(JwtHumanGuard)
    remove(@CurrentUser() user: AuthUser | null, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
        return this.executors.remove(user, id);
    }
}
