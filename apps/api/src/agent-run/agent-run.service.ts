import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AgentUsage } from '../otel/agent-usage.entity.js';
import type { AuthUser } from '../auth/auth.dto.js';

import { DEFAULT_AGENT_RUNS_PAGE_SIZE, type AgentRunDetailDto, type AgentRunDto, type AgentRunPageDto, type AgentRunsQuery, type AgentToolCallDto } from './agent-run.dto.js';
import { AgentRun, type AgentRunAgent } from './agent-run.entity.js';
import { AgentToolCall } from './agent-tool-call.entity.js';

/** The co-pilot answers human users; their conversations are private to them. */
const PRIVATE_AGENT: AgentRunAgent = 'gilde';

@Injectable()
export class AgentRunService {
    constructor(
        @InjectRepository(AgentRun) private readonly runs: Repository<AgentRun>,
        @InjectRepository(AgentToolCall) private readonly toolCalls: Repository<AgentToolCall>,
        @InjectRepository(AgentUsage) private readonly usage: Repository<AgentUsage>,
    ) { }

    /** Runs of one agent, newest first. Another user's co-pilot runs come back as metadata only. */
    async list(agentId: AgentRunAgent, q: AgentRunsQuery, viewer: AuthUser | null): Promise<AgentRunPageDto> {
        const page = q.page ?? 1;
        const pageSize = q.pageSize ?? DEFAULT_AGENT_RUNS_PAGE_SIZE;
        const query = this.runs.createQueryBuilder('r').where('r.agentId = :agentId', { agentId });
        if (q.trigger) query.andWhere('r.triggerKind = :trigger', { trigger: q.trigger });
        if (q.outcome) query.andWhere('r.outcome = :outcome', { outcome: q.outcome });
        if (q.projectId) query.andWhere('r.projectId = :projectId', { projectId: q.projectId });
        if (q.from) query.andWhere('r.startedAt >= :from', { from: q.from });
        if (q.to) query.andWhere('r.startedAt < :to', { to: q.to });
        const [rows, total] = await query.orderBy('r.startedAt', 'DESC').addOrderBy('r.id', 'DESC').skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
        return { items: await this.toDtos(rows, viewer), page, pageSize, total };
    }

    /** One run with its tool calls. Another user's co-pilot run has none: only metadata. */
    async get(id: string, viewer: AuthUser | null): Promise<AgentRunDetailDto> {
        const row = await this.runs.findOneBy({ id });
        if (!row) throw new NotFoundException('Agent run not found');
        const [dto] = await this.toDtos([row], viewer);
        if (dto.metadataOnly) return { ...dto, toolCalls: [] };
        const calls = await this.toolCalls.find({ where: { runId: id }, order: { createdAt: 'ASC', id: 'ASC' } });
        return { ...dto, toolCalls: calls.map(toToolCallDto) };
    }

    private async toDtos(rows: AgentRun[], viewer: AuthUser | null): Promise<AgentRunDto[]> {
        if (rows.length === 0) return [];
        const counts = new Map<string, number>();
        const raw = await this.toolCalls.createQueryBuilder('t')
            .select('t.runId', 'runId').addSelect('COUNT(*)', 'n')
            .where({ runId: In(rows.map((r) => r.id)) }).groupBy('t.runId')
            .getRawMany<{ runId: string; n: unknown }>();
        for (const r of raw) counts.set(r.runId, Number(r.n));
        const coding = new Map<string, { input: number; output: number; cost: number | null }>();
        const jobRunIds = rows.filter((r) => r.agentId === 'coding' && r.linkedId && r.inputTokens === null).map((r) => r.linkedId!);
        if (jobRunIds.length > 0) {
            const usage = await this.usage.createQueryBuilder('u')
                .select('u.runId', 'runId')
                .addSelect('SUM(u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens)', 'input')
                .addSelect('SUM(u.outputTokens)', 'output')
                .addSelect('SUM(u.costUsd)', 'cost')
                .where({ runId: In(jobRunIds) }).groupBy('u.runId')
                .getRawMany<{ runId: string; input: unknown; output: unknown; cost: unknown }>();
            for (const u of usage) coding.set(u.runId, { input: Number(u.input ?? 0), output: Number(u.output ?? 0), cost: u.cost === null || u.cost === undefined ? null : Number(u.cost) });
        }
        return rows.map((r) => {
            const metadataOnly = r.agentId === PRIVATE_AGENT && (!viewer?.id || r.actorUserId !== viewer.id);
            const used = r.linkedId ? coding.get(r.linkedId) : undefined;
            return {
                id: r.id,
                agentId: r.agentId,
                triggerKind: r.triggerKind,
                triggerRefType: metadataOnly ? null : r.triggerRefType,
                triggerRefId: metadataOnly ? null : r.triggerRefId,
                actorUserId: r.actorUserId,
                projectId: r.projectId,
                startedAt: r.startedAt.toISOString(),
                endedAt: r.endedAt?.toISOString() ?? null,
                outcome: r.outcome,
                reason: metadataOnly ? null : r.reason,
                model: r.model,
                inputTokens: r.inputTokens ?? used?.input ?? null,
                outputTokens: r.outputTokens ?? used?.output ?? null,
                costUsd: r.costUsd ?? used?.cost ?? null,
                linkedTable: r.linkedTable,
                linkedId: r.linkedId,
                toolCallCount: counts.get(r.id) ?? 0,
                metadataOnly,
            };
        });
    }
}

const toToolCallDto = (t: AgentToolCall): AgentToolCallDto => ({
    id: t.id, toolName: t.toolName, input: t.input, output: t.output, durationMs: t.durationMs, error: t.error, createdAt: t.createdAt.toISOString(),
});
