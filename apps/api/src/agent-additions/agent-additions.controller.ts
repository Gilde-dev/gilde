import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    ReplaceAgentInstructionSchema,
    type AgentInstructionDto, type AgentInstructionVersionDto, type AgentInstructionsDto, type ReplaceAgentInstructionDto,
} from './agent-additions.dto.js';
import { isAdditionAgent, type AdditionAgentId } from './agent-additions.render.js';
import { AgentAdditionsService } from './agent-additions.service.js';

function additionAgent(raw: string): AdditionAgentId {
    if (raw === 'coding') throw new BadRequestException('Coding agents take their repo guidance from AGENTS.md; they have no additional instructions');
    if (!isAdditionAgent(raw)) throw new NotFoundException(`Unknown agent ${raw}`);
    return raw;
}

/** Additional instructions per project and agent. Reading is for any authenticated user; changing is for admins (an interactive JWT). */
@Controller('/v1/projects/:projectId/agent-instructions')
export class AgentAdditionsController {
    constructor(private readonly service: AgentAdditionsService) { }

    @Get()
    list(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<AgentInstructionsDto> {
        return this.service.list(projectId);
    }

    @Put(':agentId')
    @UseGuards(JwtHumanGuard)
    replace(
        @CurrentUser() user: AuthUser | null,
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Param('agentId') agentId: string,
        @Body(new ZodValidationPipe(ReplaceAgentInstructionSchema)) dto: ReplaceAgentInstructionDto,
    ): Promise<AgentInstructionDto> {
        return this.service.replace(user ?? undefined, projectId, additionAgent(agentId), dto);
    }

    @Get(':agentId/history')
    history(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('agentId') agentId: string): Promise<AgentInstructionVersionDto[]> {
        return this.service.history(projectId, additionAgent(agentId));
    }
}
