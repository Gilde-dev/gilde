import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { CreateJobSchema, ListJobsQuerySchema, SetDependenciesSchema, type SetDependenciesDto, type CreateJobDto, type JobDetailResponseDto, type JobResponseDto, type ListJobsQuery } from './job.dto.js';
import { JobService } from './job.service.js';

@Controller('/v1')
export class JobController {

    constructor(private readonly jobService: JobService) { }

    @Post('repos/:repoId/jobs')
    create(
        @Param('repoId', ParseUUIDPipe) repoId: string,
        @Body(new ZodValidationPipe(CreateJobSchema)) dto: CreateJobDto,
    ): Promise<JobResponseDto> {
        return this.jobService.create(repoId, dto);
    }

    @Get('jobs')
    list(@Query(new ZodValidationPipe(ListJobsQuerySchema)) q: ListJobsQuery): Promise<JobResponseDto[]> {
        return this.jobService.list(q);
    }

    @Get('jobs/:id')
    getById(@Param('id', ParseUUIDPipe) id: string): Promise<JobDetailResponseDto> {
        return this.jobService.getDetail(id);
    }

    @Put('jobs/:id/dependencies')
    setDependencies(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(SetDependenciesSchema)) dto: SetDependenciesDto,
    ): Promise<JobResponseDto> {
        return this.jobService.setDependencies(id, dto.dependsOn);
    }

    @Post('jobs/:id/cancel')
    @HttpCode(200)
    cancel(@Param('id', ParseUUIDPipe) id: string): Promise<JobResponseDto> {
        return this.jobService.cancel(id);
    }

    @Post('jobs/:id/retry')
    @HttpCode(200)
    retry(@Param('id', ParseUUIDPipe) id: string): Promise<JobResponseDto> {
        return this.jobService.retry(id);
    }

}