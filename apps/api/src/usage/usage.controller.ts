import { Controller, Get, Post, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { AgentAttributionService, type AttributionResult } from './agent-attribution.service.js';
import { UsageQuerySchema, type UsageQuery, type UsageResponseDto } from './usage.dto.js';
import { UsageService } from './usage.service.js';

@Controller('/v1/usage')
export class UsageController {

    constructor(
        private readonly usageService: UsageService,
        private readonly attribution: AgentAttributionService,
    ) { }

    @Get()
    get(@Query(new ZodValidationPipe(UsageQuerySchema)) q: UsageQuery): Promise<UsageResponseDto> {
        return this.usageService.summary(q);
    }

    /** Runs the same attribution pass as the five-minute schedule. Ordinary JWT/API-key auth; not reachable with the ingest token. */
    @Post('agents/attribute')
    attribute(): Promise<AttributionResult> {
        return this.attribution.attribute();
    }
}
