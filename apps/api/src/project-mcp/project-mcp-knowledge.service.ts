import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { JobKnowledge } from '../execution/execution.port.js';
import {
    assembleKnowledge,
    KNOWLEDGE_QUERY_CHARS,
    knowledgeLimits,
    parseKnowledgeResult,
    type KnowledgeLimits,
    type RawSnippet,
} from '../execution/job-knowledge.js';
import { ProjectMcpService } from './project-mcp.service.js';
import { ProjectMcpServer } from './project-mcp-server.entity.js';
import { ProjectMcpTool } from './project-mcp-tool.entity.js';
import { ProjectMcpToolsService } from './project-mcp-tools.service.js';

/**
 * Knowledge for a job's payload: queries the search tool of every knowledge-enabled server of the project once with the
 * job's title and task. Fail-open: a slow, failing or misbehaving server is skipped and recorded on the server, and
 * `collect` never throws, so a dispatch is never blocked by it.
 */
@Injectable()
export class ProjectMcpKnowledgeService {
    private readonly logger = new Logger(ProjectMcpKnowledgeService.name);

    constructor(
        @InjectRepository(ProjectMcpServer) private readonly servers: Repository<ProjectMcpServer>,
        @InjectRepository(ProjectMcpTool) private readonly tools: Repository<ProjectMcpTool>,
        private readonly mcpTools: ProjectMcpToolsService,
        private readonly registry: ProjectMcpService,
    ) { }

    async collect(projectId: string, job: { title: string; task: string }, limits: KnowledgeLimits = knowledgeLimits()): Promise<JobKnowledge | null> {
        if (limits.budgetChars <= 0) return null;
        try {
            const servers = await this.servers.find({ where: { projectId, enabled: true, knowledgeEnabled: true }, order: { name: 'ASC' } });
            if (!servers.length) return null;
            const query = `${job.title}\n${job.task}`.slice(0, KNOWLEDGE_QUERY_CHARS);
            const perServer = await Promise.all(servers.map((server) => this.query(server, query, limits)));
            return assembleKnowledge(perServer, limits);
        } catch (e) {
            this.logger.warn(`Knowledge skipped for project ${projectId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
            return null;
        }
    }

    private async query(server: ProjectMcpServer, query: string, limits: KnowledgeLimits): Promise<RawSnippet[]> {
        try {
            const tool = server.knowledgeTool;
            const arg = server.knowledgeQueryArg;
            if (!tool || !arg) return await this.fail(server, 'Knowledge is enabled but has no search tool or query argument');
            const row = await this.tools.findOneBy({ serverId: server.id, name: tool });
            if (!row?.allowed || row.mode !== 'read') return await this.fail(server, `The knowledge tool ${tool} is no longer an allowed read-only tool`);
            // The tools service times out its own calls; this deadline also covers a server that stalls the connection itself.
            let timer: NodeJS.Timeout | undefined;
            const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), this.mcpTools.limits.timeoutMs); });
            const work = this.mcpTools.callForText(server, tool, { [arg]: query });
            work.catch(() => undefined);
            const result = await Promise.race([work, deadline]).finally(() => clearTimeout(timer));
            if (result === 'timeout') return await this.fail(server, 'The knowledge query timed out');
            if ('error' in result) return [];
            return parseKnowledgeResult(result.text, server.name, tool, limits.snippetChars);
        } catch {
            return await this.fail(server, 'The knowledge query failed');
        }
    }

    private async fail(server: ProjectMcpServer, error: string): Promise<RawSnippet[]> {
        try { await this.registry.recordFailure(server.id, error); } catch { /* best effort */ }
        return [];
    }
}
