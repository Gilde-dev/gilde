import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { BulkEnqueueSchema, UpdateJobSchema, type BulkEnqueueDto, type EnqueueResponseDto, type UpdateJobDto, CreateJobSchema, ListJobsQuerySchema, SetDependenciesSchema, type SetDependenciesDto, type CreateJobDto, type JobDetailResponseDto, type JobResponseDto, type ListJobsQuery, type JobPromptResponseDto } from './job.dto.js';
import { JobPromptService } from './job-prompt.service.js';
import { JobService } from './job.service.js';

@Controller('/v1')
export class JobController {

    constructor(
        private readonly jobService: JobService,
        private readonly jobPromptService: JobPromptService,
    ) { }

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

    @Get('jobs/:id/prompt')
    prompt(@Param('id', ParseUUIDPipe) id: string): Promise<JobPromptResponseDto> {
        return this.jobPromptService.get(id);
    }

    @Patch('jobs/:id')
    update(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(UpdateJobSchema)) dto: UpdateJobDto,
    ): Promise<JobResponseDto> {
        return this.jobService.update(id, dto);
    }

    @Post('jobs/enqueue')
    @HttpCode(200)
    enqueueMany(@Body(new ZodValidationPipe(BulkEnqueueSchema)) dto: BulkEnqueueDto): Promise<EnqueueResponseDto[]> {
        return this.jobService.enqueueMany(dto.ids);
    }

    @Post('jobs/:id/enqueue')
    @HttpCode(200)
    enqueue(@Param('id', ParseUUIDPipe) id: string): Promise<EnqueueResponseDto> {
        return this.jobService.enqueue(id);
    }

    @Post('jobs/:id/triage')
    @HttpCode(200)
    toTriage(@Param('id', ParseUUIDPipe) id: string): Promise<JobResponseDto> {
        return this.jobService.toTriage(id);
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