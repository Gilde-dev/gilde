import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { QueryFailedError, EntityNotFoundError } from 'typeorm';
import { z } from 'zod';

import { DispatcherService } from '../dispatch/dispatcher.service.js';
import { FeatureService } from '../feature/feature.service.js';
import { GITHUB_PORT, type GitHubPort } from '../github/github.port.js';
import { JobService } from '../job/job.service.js';
import { LessonService } from '../lesson/lesson.service.js';
import { LessonPatternService } from '../lesson/lesson-pattern.service.js';
import { HistorySearchService } from '../memory/history/history-search.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ProjectService } from '../project/project.service.js';
import { RepoService } from '../repo/repo.service.js';
import { RevisionService } from '../revision/revision.service.js';
import { SkillService } from '../skill/skill.service.js';
import { SpecService } from '../spec/spec.service.js';
import { UserService } from '../user/user.service.js';
import { RepoWorkspaceService } from '../workspace/repo-workspace.service.js';
import type { AuthUser } from '../auth/auth.dto.js';
import type { CopilotUser } from '../copilot/copilot.context.js';
import type { CopilotServices } from '../copilot/copilot.tool-bodies.js';
import { FeaturePlanService } from '../copilot/feature-plan.service.js';

import { McpToolError } from './mcp.errors.js';
import { createMcpTools, type McpAuditEvent, type McpToolDef } from './mcp.tools.js';
import { McpQuotaService } from './mcp-quota.service.js';

const MAX_ERROR_CHARS = 1000;

/**
 * The MCP transport boundary. Every POST gets its own McpServer and stateless Streamable HTTP transport (JSON responses, no
 * session id, nothing kept between requests) that are closed when the response ends. The tools close over a copy of this
 * request's authenticated user and re-check it, freshly loaded, before every execution, so identities never leak between
 * requests. The global JwtAuthGuard has already authenticated the request before this runs.
 */
@Injectable()
export class McpService {
    private readonly logger = new Logger('Mcp');
    private readonly services: CopilotServices;

    constructor(
        private readonly users: UserService,
        private readonly quota: McpQuotaService,
        jobs: JobService,
        features: FeatureService,
        revisions: RevisionService,
        dispatcher: DispatcherService,
        metrics: MetricsService,
        lessons: LessonService,
        lessonPatterns: LessonPatternService,
        skills: SkillService,
        projects: ProjectService,
        repos: RepoService,
        history: HistorySearchService,
        specs: SpecService,
        plans: FeaturePlanService,
        workspace: RepoWorkspaceService,
        @Inject(GITHUB_PORT) github: GitHubPort,
    ) {
        this.services = { jobs, features, revisions, dispatcher, metrics, lessons, lessonPatterns, skills, projects, repos, github, workspace, history, specs, plans };
    }

    /** Handles one MCP JSON-RPC POST for the request's authenticated user (undefined when auth is disabled). */
    async handle(user: AuthUser | undefined, req: Request, res: Response): Promise<void> {
        const snapshot = user ? { ...user } : undefined;
        const server = this.buildServer(snapshot);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            void transport.close().catch(() => undefined);
            void server.close().catch(() => undefined);
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            // Never log the request body or credentials: only the error class.
            this.logger.error(`MCP request failed: ${error instanceof Error ? error.name : 'unknown error'}`);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
            }
        }
    }

    /** This transport is stateless: there is no server-initiated stream and no session to end. */
    methodNotAllowed(res: Response): void {
        res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless, use POST' }, id: null });
    }

    /** One server per request with the exact registry. `user` is this request's authenticated user. */
    buildServer(user: AuthUser | undefined): McpServer {
        const server = new McpServer({ name: 'gilde', version: '1.0.0' });
        for (const tool of createMcpTools(this.services, this.quota, (e) => this.audit(e))) this.register(server, tool, user);
        return server;
    }

    private register(server: McpServer, tool: McpToolDef, user: AuthUser | undefined): void {
        server.registerTool(
            tool.name,
            { title: tool.title, description: tool.description, inputSchema: tool.inputSchema as never, annotations: tool.annotations },
            (async (input: never): Promise<CallToolResult> => {
                try {
                    const actor = await this.actorFor(user);
                    return ok(await tool.run(input, { actor }));
                } catch (error) {
                    return this.failure(tool.name, error);
                }
            }) as never,
        );
    }

    /** The operator behind this request, read fresh from the database; fails closed. */
    private async actorFor(user: AuthUser | undefined): Promise<CopilotUser> {
        try {
            const persisted = await this.users.requireOperator(user);
            return { id: persisted.id, name: user?.name, email: persisted.email, credential: user?.credential };
        } catch (error) {
            if (error instanceof HttpException) throw new McpToolError(`Not allowed: ${error.message}`, error.getStatus());
            throw error;
        }
    }

    private failure(tool: string, error: unknown): CallToolResult {
        if (error instanceof McpToolError) return fail(error.status ? `${error.message} (status ${error.status})` : error.message);
        if (error instanceof HttpException) return fail(`${error.message} (status ${error.getStatus()})`);
        if (error instanceof z.ZodError) return fail(error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        if (error instanceof QueryFailedError || error instanceof EntityNotFoundError || !(error instanceof Error)) {
            this.logger.error(`MCP tool ${tool} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
            return fail('The tool failed because of an internal error.');
        }
        return fail(error.message.slice(0, MAX_ERROR_CHARS));
    }

    private audit(e: McpAuditEvent): void {
        this.logger.log(`audit source=mcp event=${e.event} caller=${e.caller} credential=${e.credential}${e.featureId ? ` feature=${e.featureId}` : ''} jobs=${e.jobIds.join(',')}`);
    }
}

const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });
