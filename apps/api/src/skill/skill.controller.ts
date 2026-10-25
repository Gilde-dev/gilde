import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.dto.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { PromoteSkillSchema, type PromoteSkillDto, type PromoteSkillResponseDto, type RepoSkillsResponseDto, type SkillCatalogResponseDto } from './skill.dto.js';
import { SkillPromoteService } from './skill-promote.service.js';
import { SkillService } from './skill.service.js';

@Controller('/v1')
export class SkillController {
    constructor(
        private readonly skills: SkillService,
        private readonly promoter: SkillPromoteService,
    ) { }

    @Get('projects/:projectId/skills')
    catalog(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<SkillCatalogResponseDto> {
        return this.skills.catalog(projectId);
    }

    @Post('projects/:projectId/skills/refresh')
    @HttpCode(200)
    refresh(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<SkillCatalogResponseDto> {
        return this.skills.refresh(projectId);
    }

    @Get('repos/:id/skills')
    forRepo(@Param('id', ParseUUIDPipe) id: string): Promise<RepoSkillsResponseDto> {
        return this.skills.forRepo(id);
    }

    @Post('repos/:id/skills/:name/promote')
    promote(
        @Param('id', ParseUUIDPipe) id: string,
        @Param('name') name: string,
        @Body(new ZodValidationPipe(PromoteSkillSchema)) dto: PromoteSkillDto,
        @CurrentUser() user: AuthUser | null,
    ): Promise<PromoteSkillResponseDto> {
        return this.promoter.promote(id, name, dto, user);
    }
}
