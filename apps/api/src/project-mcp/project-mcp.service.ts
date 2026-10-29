import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { ExecutorSecretService } from '../executor/executor-secret.service.js';
import { ProjectService } from '../project/project.service.js';
import { UserService } from '../user/user.service.js';

import { McpConnectionError, ProjectMcpConnector } from './project-mcp.connector.js';
import {
    PROJECT_MCP_AUDIT_LIMIT,
    type CreateProjectMcpServerDto,
    type ProjectMcpServerDetailResponseDto,
    type ProjectMcpServerResponseDto,
    type ProjectMcpTestResponseDto,
    type ProjectMcpToolResponseDto,
    type ReplaceProjectMcpServerDto,
    type ReplaceProjectMcpTokenDto,
    type ReplaceProjectMcpToolsDto,
} from './project-mcp.dto.js';
import { ProjectMcpMapper } from './project-mcp.mapper.js';
import { ProjectMcpAudit, type ProjectMcpAuditAction } from './project-mcp-audit.entity.js';
import { PROJECT_MCP_KEY_VERSION, ProjectMcpServer } from './project-mcp-server.entity.js';
import { ProjectMcpTool } from './project-mcp-tool.entity.js';

/**
 * The MCP servers a project has registered. Reads are for any signed-in user; writes (including the test, which sends the
 * token to the server) need a verified human. Every change is audited; the token is never part of an audit row, a DTO or an error.
 */
@Injectable()
export class ProjectMcpService {
    constructor(
        @InjectRepository(ProjectMcpServer) private readonly servers: Repository<ProjectMcpServer>,
        @InjectRepository(ProjectMcpTool) private readonly tools: Repository<ProjectMcpTool>,
        @InjectRepository(ProjectMcpAudit) private readonly audits: Repository<ProjectMcpAudit>,
        private readonly mapper: ProjectMcpMapper,
        private readonly secrets: ExecutorSecretService,
        private readonly connector: ProjectMcpConnector,
        private readonly users: UserService,
        private readonly projects: ProjectService,
    ) { }

    async list(projectId: string): Promise<ProjectMcpServerResponseDto[]> {
        await this.projects.getById(projectId);
        const rows = await this.servers.find({ where: { projectId }, order: { name: 'ASC' } });
        return rows.map((s) => this.mapper.toDTO(s));
    }

    async get(projectId: string, id: string): Promise<ProjectMcpServerDetailResponseDto> {
        return this.detail(await this.getInProject(projectId, id));
    }

    async create(user: AuthUser | null, projectId: string, dto: CreateProjectMcpServerDto): Promise<ProjectMcpServerResponseDto> {
        const actor = await this.users.requireVerifiedHuman(user ?? undefined);
        await this.projects.getById(projectId);
        if (dto.token !== undefined) this.secrets.assertConfigured();
        await this.assertNameFree(projectId, dto.name);
        const entity = this.servers.create({
            projectId,
            name: dto.name,
            url: dto.url,
            ...(dto.enabled !== undefined && { enabled: dto.enabled }),
            ...(dto.unattendedEnabled !== undefined && { unattendedEnabled: dto.unattendedEnabled }),
            ...(dto.token !== undefined ? this.tokenColumns(dto.token) : { tokenCiphertext: null, tokenIv: null, tokenTag: null, tokenLast4: null }),
        });
        const saved = await this.save(entity, dto.name);
        await this.audit(actor, saved, 'created', {
            name: saved.name, url: saved.url, enabled: saved.enabled, unattendedEnabled: saved.unattendedEnabled, hasToken: saved.tokenLast4 !== null,
        });
        return this.mapper.toDTO(saved);
    }

    /** Replaces name, url, enabled and unattendedEnabled; the token and the allowlist are untouched. */
    async replace(user: AuthUser | null, projectId: string, id: string, dto: ReplaceProjectMcpServerDto): Promise<ProjectMcpServerResponseDto> {
        const actor = await this.users.requireVerifiedHuman(user ?? undefined);
        const entity = await this.getInProject(projectId, id);
        if (dto.name !== entity.name) await this.assertNameFree(projectId, dto.name);
        const next = { name: dto.name, url: dto.url, enabled: dto.enabled, unattendedEnabled: dto.unattendedEnabled };
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [field, to] of Object.entries(next)) {
            const from = entity[field as keyof typeof next];
            if (from !== to) changes[field] = { from, to };
        }
        Object.assign(entity, next);
        const saved = await this.save(entity, dto.name);
        if (Object.keys(changes).length) await this.audit(actor, saved, 'updated', changes);
        return this.mapper.toDTO(saved);
    }

    async replaceToken(user: AuthUser | null, projectId: string, id: string, dto: ReplaceProjectMcpTokenDto): Promise<void> {
        const actor = await this.users.requireVerifiedHuman(user ?? undefined);
        this.secrets.assertConfigured();
        const entity = await this.getInProject(projectId, id);
        await this.servers.update({ id }, this.tokenColumns(dto.token));
        await this.audit(actor, entity, 'token_replaced', {});
    }

    async remove(user: AuthUser | null, projectId: string, id: string): Promise<void> {
        const actor = await this.users.requireVerifiedHuman(user ?? undefined);
        const entity = await this.getInProject(projectId, id);
        await this.servers.delete({ id });
        await this.audit(actor, entity, 'deleted', {});
    }

    /**
     * Initializes the server and lists its tools; never calls one. Tools that still exist keep their allowed flag and mode,
     * new ones start not allowed (mode from the annotations), vanished ones are dropped. A failure is a normal answer.
     */
    async test(user: AuthUser | null, projectId: string, id: string): Promise<ProjectMcpTestResponseDto> {
        const actor = await this.users.requireVerifiedHuman(user ?? undefined);
        const entity = await this.getInProject(projectId, id);
        const token = entity.tokenLast4 !== null ? await this.revealToken(id) : null;
        const now = new Date();
        try {
            const discovered = await this.connector.listTools(entity.url, token);
            const existing = new Map((await this.tools.find({ where: { serverId: id } })).map((t) => [t.name, t]));
            const seen = new Set<string>();
            const rows: ProjectMcpTool[] = [];
            for (const tool of discovered) {
                if (seen.has(tool.name)) continue;
                seen.add(tool.name);
                const row = existing.get(tool.name);
                rows.push(row
                    ? Object.assign(row, { description: tool.description })
                    : this.tools.create({ serverId: id, name: tool.name, description: tool.description, mode: tool.mode, allowed: false }));
            }
            const dropped = [...existing.keys()].filter((name) => !seen.has(name));
            if (dropped.length) await this.tools.delete({ serverId: id, name: In(dropped) });
            const saved = await this.tools.save(rows);
            await this.servers.update({ id }, { lastTestedAt: now, lastError: null, lastErrorAt: null });
            await this.audit(actor, entity, 'tested', { ok: true, tools: saved.length, dropped });
            return { ok: true, errorKind: null, message: null, tools: this.sorted(saved).map((t) => this.mapper.toToolDTO(t)) };
        } catch (e) {
            if (!(e instanceof McpConnectionError)) throw e;
            await this.servers.update({ id }, { lastTestedAt: now, lastError: e.message, lastErrorAt: now });
            await this.audit(actor, entity, 'tested', { ok: false, errorKind: e.kind });
            const current = await this.tools.find({ where: { serverId: id } });
            return { ok: false, errorKind: e.kind, message: e.message, tools: this.sorted(current).map((t) => this.mapper.toToolDTO(t)) };
        }
    }

    /** Replaces the allowlist and modes: listed tools get the given values, tools not listed become not allowed. */
    async replaceTools(user: AuthUser | null, projectId: string, id: string, dto: ReplaceProjectMcpToolsDto): Promise<ProjectMcpToolResponseDto[]> {
        const actor = await this.users.requireVerifiedHuman(user ?? undefined);
        const entity = await this.getInProject(projectId, id);
        const names = dto.tools.map((t) => t.name);
        if (new Set(names).size !== names.length) throw new BadRequestException('A tool is listed twice');
        const rows = await this.tools.find({ where: { serverId: id } });
        const byName = new Map(rows.map((t) => [t.name, t]));
        const unknown = names.filter((n) => !byName.has(n));
        if (unknown.length) throw new BadRequestException(`Unknown tools (test the connection first): ${unknown.join(', ')}`);
        const wanted = new Map(dto.tools.map((t) => [t.name, t]));
        const changes: { tool: string; allowed?: { from: boolean; to: boolean }; mode?: { from: string; to: string } }[] = [];
        for (const row of rows) {
            const want = wanted.get(row.name);
            const allowed = want?.allowed ?? false;
            const mode = want?.mode ?? row.mode;
            const change: (typeof changes)[number] = { tool: row.name };
            if (row.allowed !== allowed) change.allowed = { from: row.allowed, to: allowed };
            if (row.mode !== mode) change.mode = { from: row.mode, to: mode };
            if (change.allowed || change.mode) changes.push(change);
            row.allowed = allowed;
            row.mode = mode;
        }
        const saved = await this.tools.save(rows);
        if (changes.length) await this.audit(actor, entity, 'tools_updated', { tools: changes });
        return this.sorted(saved).map((t) => this.mapper.toToolDTO(t));
    }

    /**
     * Internal, for the agents' tool layer only (never behind a route): the decrypted token of a server. The caller must not
     * log it or put it in a DTO, prompt, notification or error.
     */
    async revealToken(id: string): Promise<string | null> {
        const row = await this.servers.findOne({
            where: { id },
            select: { id: true, tokenCiphertext: true, tokenIv: true, tokenTag: true, keyVersion: true },
        });
        if (!row) throw new NotFoundException(`MCP server ${id} not found`);
        if (!row.tokenCiphertext || !row.tokenIv || !row.tokenTag) return null;
        return this.secrets.decrypt({ ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag, keyVersion: row.keyVersion }, PROJECT_MCP_KEY_VERSION);
    }

    /** Internal: counts one tool call of a server; a failure records a short, token-free message as its last error. */
    async recordCall(id: string, error: string | null, now = new Date()): Promise<void> {
        await this.servers.increment({ id }, 'callCount', 1);
        if (error === null) return;
        await this.servers.increment({ id }, 'errorCount', 1);
        await this.servers.update({ id }, { lastError: error.slice(0, 500), lastErrorAt: now });
    }

    private tokenColumns(token: string) {
        const encrypted = this.secrets.encrypt(token, PROJECT_MCP_KEY_VERSION);
        return {
            tokenCiphertext: encrypted.ciphertext,
            tokenIv: encrypted.iv,
            tokenTag: encrypted.tag,
            keyVersion: encrypted.keyVersion,
            tokenLast4: token.slice(-4),
        };
    }

    private async detail(entity: ProjectMcpServer): Promise<ProjectMcpServerDetailResponseDto> {
        const [tools, audit] = await Promise.all([
            this.tools.find({ where: { serverId: entity.id } }),
            this.audits.find({ where: { serverId: entity.id }, order: { createdAt: 'DESC' }, take: PROJECT_MCP_AUDIT_LIMIT }),
        ]);
        return {
            ...this.mapper.toDTO(entity),
            tools: this.sorted(tools).map((t) => this.mapper.toToolDTO(t)),
            audit: audit.map((a) => this.mapper.toAuditDTO(a)),
        };
    }

    private sorted(tools: ProjectMcpTool[]): ProjectMcpTool[] {
        return [...tools].sort((a, b) => a.name.localeCompare(b.name));
    }

    private async audit(actor: { id: string; email: string }, server: ProjectMcpServer, action: ProjectMcpAuditAction, changes: Record<string, unknown>): Promise<void> {
        await this.audits.save(this.audits.create({
            serverId: server.id,
            projectId: server.projectId,
            serverName: server.name,
            actorId: actor.id,
            actorEmail: actor.email,
            action,
            changes,
            // Explicit, so entries made within one second keep their order (SQLite's default has second resolution).
            createdAt: new Date(),
        }));
    }

    private async getInProject(projectId: string, id: string): Promise<ProjectMcpServer> {
        const entity = await this.servers.findOneBy({ id, projectId });
        if (!entity) throw new NotFoundException(`MCP server ${id} not found`);
        return entity;
    }

    private async assertNameFree(projectId: string, name: string): Promise<void> {
        if (await this.servers.existsBy({ projectId, name })) throw new ConflictException(`This project already has an MCP server named ${name}`);
    }

    private async save(entity: ProjectMcpServer, name: string): Promise<ProjectMcpServer> {
        try {
            return await this.servers.save(entity);
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`This project already has an MCP server named ${name}`);
            throw e;
        }
    }
}
