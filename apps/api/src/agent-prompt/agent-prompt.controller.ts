import { Controller, Get, Param, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { PromptQuerySchema, type AgentPromptDto, type PromptQuery } from './agent-prompt.dto.js';
import { AgentPromptService } from './agent-prompt.service.js';

/** The prompts of the agents, read-only: there is no route that changes one (they live in code). */
@Controller('/v1/agents')
export class AgentPromptController {
    constructor(private readonly service: AgentPromptService) { }

    @Get(':id/prompt')
    get(@Param('id') id: string, @Query(new ZodValidationPipe(PromptQuerySchema)) q: PromptQuery): Promise<AgentPromptDto> {
        return this.service.get(id, q.projectId);
    }
}
