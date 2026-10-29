import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    CreateProjectMcpServerSchema,
    ReplaceProjectMcpServerSchema,
    ReplaceProjectMcpTokenSchema,
    ReplaceProjectMcpToolsSchema,
    type CreateProjectMcpServerDto,
    type ProjectMcpServerDetailResponseDto,
    type ProjectMcpServerResponseDto,
    type ProjectMcpTestResponseDto,
    type ProjectMcpToolResponseDto,
    type ReplaceProjectMcpServerDto,
    type ReplaceProjectMcpTokenDto,
    type ReplaceProjectMcpToolsDto,
} from './project-mcp.dto.js';
import { ProjectMcpService } from './project-mcp.service.js';

/** A project's MCP servers. Writes are for verified humans only (interactive JWT, no API keys, bots or the scout). */
@Controller('/v1/projects/:projectId/mcp-servers')
export class ProjectMcpController {
    constructor(private readonly servers: ProjectMcpService) { }

    @Get()
    list(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<ProjectMcpServerResponseDto[]> {
        return this.servers.list(projectId);
    }

    @Post()
    @UseGuards(JwtHumanGuard)
    create(
        @CurrentUser() user: AuthUser | null,
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Body(new ZodValidationPipe(CreateProjectMcpServerSchema)) dto: CreateProjectMcpServerDto,
    ): Promise<ProjectMcpServerResponseDto> {
        return this.servers.create(user, projectId, dto);
    }

    @Get(':id')
    get(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<ProjectMcpServerDetailResponseDto> {
        return this.servers.get(projectId, id);
    }

    @Put(':id')
    @UseGuards(JwtHumanGuard)
    replace(
        @CurrentUser() user: AuthUser | null,
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(ReplaceProjectMcpServerSchema)) dto: ReplaceProjectMcpServerDto,
    ): Promise<ProjectMcpServerResponseDto> {
        return this.servers.replace(user, projectId, id, dto);
    }

    @Put(':id/token')
    @HttpCode(204)
    @UseGuards(JwtHumanGuard)
    replaceToken(
        @CurrentUser() user: AuthUser | null,
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(ReplaceProjectMcpTokenSchema)) dto: ReplaceProjectMcpTokenDto,
    ): Promise<void> {
        return this.servers.replaceToken(user, projectId, id, dto);
    }

    @Post(':id/test')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    test(
        @CurrentUser() user: AuthUser | null,
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<ProjectMcpTestResponseDto> {
        return this.servers.test(user, projectId, id);
    }

    @Put(':id/tools')
    @UseGuards(JwtHumanGuard)
    replaceTools(
        @CurrentUser() user: AuthUser | null,
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(ReplaceProjectMcpToolsSchema)) dto: ReplaceProjectMcpToolsDto,
    ): Promise<ProjectMcpToolResponseDto[]> {
        return this.servers.replaceTools(user, projectId, id, dto);
    }

    @Delete(':id')
    @HttpCode(204)
    @UseGuards(JwtHumanGuard)
    remove(
        @CurrentUser() user: AuthUser | null,
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        return this.servers.remove(user, projectId, id);
    }
}
