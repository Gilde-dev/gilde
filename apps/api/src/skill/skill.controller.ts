import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import type { RepoSkillsResponseDto, SkillCatalogResponseDto } from './skill.dto.js';
import { SkillService } from './skill.service.js';

@Controller('/v1')
export class SkillController {
    constructor(private readonly skills: SkillService) { }

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
}
