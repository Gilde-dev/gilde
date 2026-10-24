import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    type CreateProjectDto,
    CreateProjectSchema,
    ProjectResponseDto,
    type UpdateProjectDto,
    UpdateProjectSchema,
} from './project.dto.js';

import { ProjectService } from './project.service.js';

@Controller('/v1/projects')
export class ProjectController {
    constructor(private readonly projectService: ProjectService) { }

    @Get()
    list(): Promise<ProjectResponseDto[]> {
        return this.projectService.list();
    }

    @Get('by-slug/:slug')
    getBySlug(@Param('slug') slug: string): Promise<ProjectResponseDto> {
        return this.projectService.getBySlug(slug);
    }

    @Get(':id')
    getById(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectResponseDto> {
        return this.projectService.getById(id);
    }

    @Post()
    create(@Body(new ZodValidationPipe(CreateProjectSchema)) dto: CreateProjectDto): Promise<ProjectResponseDto> {
        return this.projectService.create(dto);
    }

    @Patch(':id')
    update(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(UpdateProjectSchema)) dto: UpdateProjectDto,
    ): Promise<ProjectResponseDto> {
        return this.projectService.update(id, dto);
    }

    @Post(':id/pause')
    @HttpCode(200)
    pause(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectResponseDto> {
        return this.projectService.pause(id);
    }

    @Post(':id/resume')
    @HttpCode(200)
    resume(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectResponseDto> {
        return this.projectService.resume(id);
    }
}