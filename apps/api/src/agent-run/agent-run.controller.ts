import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.dto.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { AgentIdSchema, AgentRunsQuerySchema, type AgentRunDetailDto, type AgentRunPageDto, type AgentRunsQuery } from './agent-run.dto.js';
import { AgentRunService } from './agent-run.service.js';

/** The run log, read-only. Ordinary JWT / API-key auth; other users' co-pilot runs are metadata only. */
@Controller('/v1')
export class AgentRunController {
    constructor(private readonly service: AgentRunService) { }

    @Get('agents/:id/runs')
    list(
        @Param('id') id: string,
        @Query(new ZodValidationPipe(AgentRunsQuerySchema)) q: AgentRunsQuery,
        @CurrentUser() user: AuthUser | null,
    ): Promise<AgentRunPageDto> {
        const agent = AgentIdSchema.safeParse(id);
        if (!agent.success) throw new NotFoundException(`Unknown agent "${id}"`);
        return this.service.list(agent.data, q, user);
    }

    @Get('agent-runs/:id')
    get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<AgentRunDetailDto> {
        return this.service.get(id, user);
    }
}
