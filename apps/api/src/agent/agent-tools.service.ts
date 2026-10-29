import { Injectable } from '@nestjs/common';

import { ApiKeyService } from '../api-key/api-key.service.js';
import { NOTIFICATION_KINDS } from '../notification/notification.entity.js';
import { ProjectService } from '../project/project.service.js';
import { ProjectMcpService } from '../project-mcp/project-mcp.service.js';
import { UserService } from '../user/user.service.js';

import type { AgentId } from './agent-ids.js';
import { TOOLS_NOTE, toolsOf } from './agent-tools.js';
import type { AgentProjectToolsDto, AgentToolsDto, SlackBotDto } from './agent.dto.js';

/** A bot key that was used this recently counts as the channels app being connected. */
const SLACK_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Which agents get the project MCP tools, and for which audience (see ProjectMcpToolsService.buildTools). */
const MCP_AUDIENCE: Partial<Record<AgentId, 'copilot' | 'unattended'>> = { gilde: 'copilot', verkenner: 'unattended', verfijner: 'unattended' };

@Injectable()
export class AgentToolsService {
    constructor(
        private readonly projects: ProjectService,
        private readonly mcp: ProjectMcpService,
        private readonly users: UserService,
        private readonly apiKeys: ApiKeyService,
    ) { }

    async toolsFor(agent: AgentId): Promise<AgentToolsDto> {
        const tools = toolsOf(agent);
        return {
            agent,
            kind: tools ? 'allowlist' : 'routine',
            tools: tools ?? [],
            note: TOOLS_NOTE[agent],
            projectTools: await this.projectTools(agent),
        };
    }

    /**
     * Per project the tools of the enabled MCP servers an agent would get: the co-pilot all allowed tools (writes need the
     * user's confirmation), the unattended agents only read tools of servers that were opted in. Only servers with at least
     * one such tool are listed.
     */
    private async projectTools(agent: AgentId): Promise<AgentProjectToolsDto[]> {
        const audience = MCP_AUDIENCE[agent];
        if (!audience) return [];
        const result: AgentProjectToolsDto[] = [];
        for (const project of await this.projects.list()) {
            const servers = (await this.mcp.list(project.id)).filter((s) => s.enabled && (audience === 'copilot' || s.unattendedEnabled));
            const listed: AgentProjectToolsDto['servers'] = [];
            for (const server of servers) {
                const detail = await this.mcp.get(project.id, server.id);
                const tools = detail.tools
                    .filter((t) => t.allowed && (audience === 'copilot' || t.mode === 'read'))
                    .map((t) => ({ name: t.name, mode: t.mode, needsApproval: audience === 'copilot' && t.mode === 'write' }));
                if (tools.length > 0) listed.push({ serverId: server.id, serverName: server.name, tools });
            }
            if (listed.length > 0) result.push({ projectId: project.id, projectName: project.name, servers: listed });
        }
        return result;
    }

    /**
     * The Slack bot is the channels app, a separate process: Gilde sees it only as a bot user with an API key. It counts as
     * on when such a key was used in the last 24 hours.
     */
    async slackBot(now = new Date()): Promise<SlackBotDto> {
        const botUsers: SlackBotDto['botUsers'] = [];
        for (const bot of await this.users.listBots()) {
            const keys = (await this.apiKeys.list(bot.id)).filter((k) => !k.expiresAt || new Date(k.expiresAt) > now);
            if (keys.length === 0) continue;
            const used = keys.map((k) => k.lastUsedAt).filter((v): v is string => v !== null).sort().at(-1) ?? null;
            botUsers.push({ id: bot.id, name: bot.name, email: bot.email, lastUsedAt: used });
        }
        const recent = botUsers.find((b) => b.lastUsedAt && now.getTime() - new Date(b.lastUsedAt).getTime() < SLACK_ACTIVE_WINDOW_MS);
        return {
            id: 'slack',
            label: 'Slack bot',
            status: recent ? 'on' : 'off',
            reason: recent
                ? `Its bot API key was used ${recent.lastUsedAt}`
                : botUsers.length === 0
                    ? 'No bot user has an API key; the channels app cannot connect'
                    : 'No bot API key was used in the last 24 hours; the channels app may not be running',
            botUsers,
            notificationKinds: [...NOTIFICATION_KINDS],
        };
    }
}
