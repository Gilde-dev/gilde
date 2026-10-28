import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { JobEventsService } from './job-events.service.js';
import { SendBackSchema, type JobResponseDto, type SendBackDto } from './job.dto.js';
import { JobService } from './job.service.js';

/** Lives next to JobEventsService (not JobController) because JobModule cannot import JobEventsModule. */
@Controller('/v1')
export class JobSendBackController {

    constructor(
        private readonly jobService: JobService,
        private readonly events: JobEventsService,
    ) { }

    @Post('jobs/:id/send-back')
    @HttpCode(200)
    async sendBack(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(SendBackSchema)) dto: SendBackDto,
    ): Promise<JobResponseDto> {
        await this.events.sendBackById(id, dto.reason);
        return this.jobService.getById(id);
    }

}
