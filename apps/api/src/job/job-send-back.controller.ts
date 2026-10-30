import { Body, Controller, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UserService } from '../user/user.service.js';

import { JobEventsService } from './job-events.service.js';
import { SendBackSchema, type JobResponseDto, type SendBackDto } from './job.dto.js';
import { JobService } from './job.service.js';
import { MergeConflictService } from './merge-conflict.service.js';

/** Lives next to JobEventsService (not JobController) because JobModule cannot import JobEventsModule. */
@Controller('/v1')
export class JobSendBackController {

    constructor(
        private readonly jobService: JobService,
        private readonly events: JobEventsService,
        private readonly conflicts: MergeConflictService,
        private readonly users: UserService,
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

    /** Sends a conflicted PR back with the fixed merge instruction; verified humans only, and it uses no attempt. */
    @Post('jobs/:id/fix-conflicts')
    @UseGuards(JwtHumanGuard)
    @HttpCode(200)
    async fixConflicts(
        @CurrentUser() user: AuthUser | null,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<JobResponseDto> {
        await this.users.requireVerifiedHuman(user ?? undefined);
        await this.conflicts.fixConflicts(id);
        return this.jobService.getById(id);
    }

    /** Marks one operator action of the job's latest run done; verified humans only, and the job's status does not change. */
    @Post('jobs/:id/operator-actions/:index/done')
    @UseGuards(JwtHumanGuard)
    @HttpCode(200)
    async markOperatorActionDone(
        @CurrentUser() user: AuthUser | null,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('index', ParseIntPipe) index: number,
    ): Promise<JobResponseDto> {
        const human = await this.users.requireVerifiedHuman(user ?? undefined);
        return this.jobService.markOperatorActionDone(id, index, human.id);
    }

}
