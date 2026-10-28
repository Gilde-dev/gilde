import { Controller, Get, Post, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { AgentAttributionService } from './agent-attribution.service.js';
import { AgentUsageQuerySchema, type AgentUsageQuery, type AttributionResult } from './usage.dto.js';
import type { AgentUsageResponseDto } from './agent-totals.dto.js';
import { AgentUsageService } from './agent-usage.service.js';
import { UsageQuerySchema, type UsageQuery, type UsageResponseDto } from './usage.dto.js';
import { UsageService } from './usage.service.js';

@Controller('/v1/usage')
export class UsageController {

    constructor(
        private readonly usageService: UsageService,
        private readonly attribution: AgentAttributionService,
        private readonly agentUsage: AgentUsageService,
    ) { }

    @Get()
    get(@Query(new ZodValidationPipe(UsageQuerySchema)) q: UsageQuery): Promise<UsageResponseDto> {
        return this.usageService.summary(q);
    }

    /** Claude Code usage over the last `days` UTC days; ordinary JWT/API-key auth. */
    @Get('agents')
    agents(@Query(new ZodValidationPipe(AgentUsageQuerySchema)) q: AgentUsageQuery): Promise<AgentUsageResponseDto> {
        return this.agentUsage.summary(q.days, q.projectId);
    }

    /** Runs the same attribution pass as the five-minute schedule. Ordinary JWT/API-key auth; not reachable with the ingest token. */
    @Post('agents/attribute')
    attribute(): Promise<AttributionResult> {
        return this.attribution.attribute();
    }
}
