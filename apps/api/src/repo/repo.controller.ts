import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    CreateRepoSchema,
    UpdateRepoSchema,
    type CreateRepoDto,
    type RepoResponseDto,
    type UpdateRepoDto,
} from './repo.dto.js';
import { RepoService } from './repo.service.js';

@Controller('/v1')
export class RepoController {
    constructor(private readonly repoService: RepoService) { }

    @Get('projects/:projectId/repos')
    listForProject(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<RepoResponseDto[]> {
        return this.repoService.listForProject(projectId);
    }

    @Post('projects/:projectId/repos')
    create(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Body(new ZodValidationPipe(CreateRepoSchema)) dto: CreateRepoDto,
    ): Promise<RepoResponseDto> {
        return this.repoService.create(projectId, dto);
    }

    // ── A single repo ────────────────────────────────────────────────

    @Get('repos/:id')
    getById(@Param('id', ParseUUIDPipe) id: string): Promise<RepoResponseDto> {
        return this.repoService.getById(id);
    }

    @Patch('repos/:id')
    update(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(UpdateRepoSchema)) dto: UpdateRepoDto,
    ): Promise<RepoResponseDto> {
        return this.repoService.update(id, dto);
    }

    @Post('repos/:id/pause')
    @HttpCode(200)
    pause(@Param('id', ParseUUIDPipe) id: string): Promise<RepoResponseDto> {
        return this.repoService.pause(id);
    }

    @Post('repos/:id/resume')
    @HttpCode(200)
    resume(@Param('id', ParseUUIDPipe) id: string): Promise<RepoResponseDto> {
        return this.repoService.resume(id);
    }
}