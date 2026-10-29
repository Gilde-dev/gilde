import { Body, Controller, Get, NotFoundException, Param, Put, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { isAgentId, type AgentId } from './agent-ids.js';
import { AgentToolsService } from './agent-tools.service.js';
import { AgentSettingsService } from './agent-settings.service.js';
import { ReplaceAgentSettingsSchema, type AgentAuditEntryDto, type AgentBotUserDto, type AgentDto, type AgentToolsDto, type ReplaceAgentSettingsDto, type SlackBotDto } from './agent.dto.js';
import { AgentMapper } from './agent.mapper.js';

function agentId(raw: string): AgentId {
    if (!isAgentId(raw)) throw new NotFoundException(`Unknown agent ${raw}`);
    return raw;
}

/**
 * The agents and bots of Gilde with their runtime settings and effective status. Reading is for any authenticated user;
 * changing settings is for verified humans only (interactive JWT: no API keys, bots or the scout).
 */
@Controller('/v1/agents')
export class AgentController {
    constructor(private readonly settings: AgentSettingsService, private readonly mapper: AgentMapper, private readonly tools: AgentToolsService) { }

    @Get()
    async list(): Promise<AgentDto[]> {
        return (await this.settings.list()).map((a) => this.mapper.toDTO(a));
    }

    /** Users marked as bots: what the bot user of an agent is chosen from. */
    @Get('bot-users')
    botUsers(): Promise<AgentBotUserDto[]> {
        return this.settings.botUsers();
    }

    /** The Slack bot (the channels app): its bot account and the notification kinds it delivers. It has no stored settings. */
    @Get('slack')
    slack(): Promise<SlackBotDto> {
        return this.tools.slackBot();
    }

    @Get(':id')
    async get(@Param('id') id: string): Promise<AgentDto> {
        return this.mapper.toDTO(await this.settings.get(agentId(id)));
    }

    /** The exact tool allowlist of an agent, built from the factories the agent itself uses. */
    @Get(':id/tools')
    toolsOf(@Param('id') id: string): Promise<AgentToolsDto> {
        return this.tools.toolsFor(agentId(id));
    }

    @Put(':id/settings')
    @UseGuards(JwtHumanGuard)
    async replace(
        @CurrentUser() user: AuthUser | null,
        @Param('id') id: string,
        @Body(new ZodValidationPipe(ReplaceAgentSettingsSchema)) dto: ReplaceAgentSettingsDto,
    ): Promise<AgentDto> {
        return this.mapper.toDTO(await this.settings.replace(user ?? undefined, agentId(id), dto));
    }

    @Get(':id/audit')
    audit(@Param('id') id: string): Promise<AgentAuditEntryDto[]> {
        return this.settings.auditOf(agentId(id));
    }
}
