import { Body, Controller, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { JobEventsService } from './job-events.service.js';
import { SendBackSchema, type JobResponseDto, type SendBackDto } from './job.dto.js';
import { Job } from './job.entity.js';
import { JobService } from './job.service.js';

/** Lives next to JobEventsService (not JobController) because JobModule cannot import JobEventsModule. */
@Controller('/v1')
export class JobSendBackController {

    constructor(
        private readonly jobService: JobService,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        private readonly events: JobEventsService,
    ) { }

    @Post('jobs/:id/send-back')
    @HttpCode(200)
    async sendBack(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(SendBackSchema)) dto: SendBackDto,
    ): Promise<JobResponseDto> {
        const job = await this.jobs.findOneBy({ id });
        if (!job) throw new NotFoundException('Job not found');
        await this.events.sendBack(job, dto.reason);
        return this.jobService.getById(id);
    }

}
