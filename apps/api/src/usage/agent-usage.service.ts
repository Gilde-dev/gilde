import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type SelectQueryBuilder } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { Job } from '../job/job.entity.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';

import { DEFAULT_USAGE_DAYS } from './usage.dto.js';
import type { AgentTotalsDto, AgentUsageResponseDto, AgentUsageFilter, AgentUsageWindow } from './agent-totals.dto.js';

const DAY_MS = 86_400_000;

export const emptyAgentTotals = (): AgentTotalsDto => ({
    inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
    costUsd: null, runs: 0, uncachedInputTokens: 0, costUnknownRequests: 0, costPartial: false,
});

interface RawTotals {
    uncached: unknown; cacheRead: unknown; cacheCreation: unknown; output: unknown; requests: unknown; cost: unknown; costKnown: unknown;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function toTotals(r: RawTotals | undefined): AgentTotalsDto {
    if (!r) return emptyAgentTotals();
    const uncached = num(r.uncached), cacheRead = num(r.cacheRead), cacheCreation = num(r.cacheCreation), output = num(r.output);
    const requests = num(r.requests), known = num(r.costKnown);
    const inputTokens = uncached + cacheRead + cacheCreation;
    return {
        inputTokens,
        cachedInputTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        outputTokens: output,
        reasoningTokens: 0,
        totalTokens: inputTokens + output,
        costUsd: known > 0 && r.cost !== null && r.cost !== undefined ? Number(r.cost) : null,
        runs: requests,
        uncachedInputTokens: uncached,
        costUnknownRequests: requests - known,
        costPartial: known > 0 && known < requests,
    };
}

/** The UTC day window ending today, like `UsageService.summary`. */
export function agentWindow(days: number, now: Date): AgentUsageWindow {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return { days, from: new Date(today - (days - 1) * DAY_MS), to: new Date(today + DAY_MS) };
}

/**
 * Read-side aggregates of `agent_usage`, computed in SQL with joins (no list caps, no per-item queries).
 * Project, repo, job and feature come from the ATTRIBUTED run; rows without a run have an unknown project and only
 * appear in the global scope (`byX` with no `projectId`) and in `unattributed`. Costs are Claude Code's estimates, never recalculated.
 */
@Injectable()
export class AgentUsageService {
    constructor(@InjectRepository(AgentUsage) private readonly rows: Repository<AgentUsage>) { }

    async summary(days: number = DEFAULT_USAGE_DAYS, projectId?: string, now = new Date()): Promise<AgentUsageResponseDto> {
        const window = agentWindow(days, now);
        const f: AgentUsageFilter = { projectId, from: window.from, to: window.to };
        const [totals, daily, byModel, byRepo, byFeature, unattributed] = await Promise.all([
            this.totals(f), this.byDay(window, { projectId }), this.byModel(f), this.byRepo(f), this.byFeature(f),
            projectId ? Promise.resolve(emptyAgentTotals()) : this.unattributed({ from: window.from, to: window.to }),
        ]);
        return { days, scope: projectId ? 'project' : 'global', projectId: projectId ?? null, totals, daily, byModel, byRepo, byFeature, unattributed };
    }

    private isPostgres(): boolean {
        return this.rows.manager.connection.options.type === 'postgres';
    }

    private base(f: AgentUsageFilter): SelectQueryBuilder<AgentUsage> {
        const qb = this.rows.createQueryBuilder('a')
            .leftJoin(JobRun, 'r', 'r.id = a.runId')
            .leftJoin(Job, 'j', 'j.id = r.jobId')
            .select('SUM(a.inputTokens)', 'uncached')
            .addSelect('SUM(a.cacheReadTokens)', 'cacheRead')
            .addSelect('SUM(a.cacheCreationTokens)', 'cacheCreation')
            .addSelect('SUM(a.outputTokens)', 'output')
            .addSelect('COUNT(*)', 'requests')
            .addSelect('SUM(a.costUsd)', 'cost')
            .addSelect('COUNT(a.costUsd)', 'costKnown');
        if (f.from) qb.andWhere('a.eventAt >= :from', { from: f.from });
        if (f.to) qb.andWhere('a.eventAt < :to', { to: f.to });
        if (f.projectId) qb.andWhere('r.projectId = :projectId', { projectId: f.projectId });
        return qb;
    }

    /** Everything in scope; with no `projectId` this includes unattributed rows exactly once. */
    async totals(f: AgentUsageFilter = {}): Promise<AgentTotalsDto> {
        return toTotals(await this.base(f).getRawOne<RawTotals>());
    }

    /** Rows without a run (unknown project): global scope only. */
    async unattributed(f: Omit<AgentUsageFilter, 'projectId'> = {}): Promise<AgentTotalsDto> {
        return toTotals(await this.base(f).andWhere('a.runId IS NULL').getRawOne<RawTotals>());
    }

    private async grouped(key: string, f: AgentUsageFilter, ids?: string[], where?: string): Promise<Map<string | null, AgentTotalsDto>> {
        const qb = this.base(f).addSelect(key, 'k').groupBy(key);
        if (ids) {
            if (ids.length === 0) return new Map();
            qb.andWhere(`${key} IN (:...ids)`, { ids });
        }
        if (where) qb.andWhere(where);
        const raw = await qb.getRawMany<RawTotals & { k: string | null }>();
        return new Map(raw.map((r) => [r.k ?? null, toTotals(r)]));
    }

    /** Lifetime (or filtered) totals per run id; ids without rows are absent. */
    forRuns(runIds: string[], f: AgentUsageFilter = {}): Promise<Map<string | null, AgentTotalsDto>> {
        return this.grouped('a.runId', f, runIds);
    }

    forJobs(jobIds: string[], f: AgentUsageFilter = {}): Promise<Map<string | null, AgentTotalsDto>> {
        return this.grouped('r.jobId', f, jobIds);
    }

    forFeatures(featureIds: string[], f: AgentUsageFilter = {}): Promise<Map<string | null, AgentTotalsDto>> {
        return this.grouped('j.featureId', f, featureIds);
    }

    /** Totals per repo of the attributed run, largest first; unattributed rows are not part of any repo. */
    async byRepo(f: AgentUsageFilter = {}): Promise<(AgentTotalsDto & { repoId: string; fullName: string | null })[]> {
        const map = await this.grouped('r.repoId', f, undefined, 'a.runId IS NOT NULL');
        const ids = [...map.keys()].filter((k): k is string => k !== null);
        const names = new Map((ids.length ? await this.rows.manager.getRepository(Repo).find({ where: { id: In(ids) } }) : []).map((r) => [r.id, r.fullName]));
        return ids.map((repoId) => ({ repoId, fullName: names.get(repoId) ?? null, ...map.get(repoId)! })).sort(bySize);
    }

    /** Totals per feature of the attributed job; jobs without a feature are left out. */
    async byFeature(f: AgentUsageFilter = {}): Promise<(AgentTotalsDto & { featureId: string; title: string | null })[]> {
        const map = await this.grouped('j.featureId', f, undefined, 'j.featureId IS NOT NULL');
        const ids = [...map.keys()].filter((k): k is string => k !== null);
        const titles = new Map((ids.length ? await this.rows.manager.getRepository(Feature).find({ where: { id: In(ids) } }) : []).map((x) => [x.id, x.title]));
        return ids.map((featureId) => ({ featureId, title: titles.get(featureId) ?? null, ...map.get(featureId)! })).sort(bySize);
    }

    async byModel(f: AgentUsageFilter = {}): Promise<(AgentTotalsDto & { model: string })[]> {
        const map = await this.grouped('a.model', f);
        return [...map].map(([model, t]) => ({ model: model ?? '', ...t })).sort(bySize);
    }

    /** One entry per UTC event date of the window, zero-filled. */
    async byDay(window: AgentUsageWindow, f: Omit<AgentUsageFilter, 'from' | 'to'> = {}): Promise<(AgentTotalsDto & { date: string })[]> {
        const key = this.isPostgres() ? "to_char(a.eventAt, 'YYYY-MM-DD')" : "strftime('%Y-%m-%d', a.eventAt)";
        const map = await this.grouped(key, { ...f, from: window.from, to: window.to });
        return Array.from({ length: window.days }, (_, i) => {
            const date = new Date(window.from.getTime() + i * DAY_MS).toISOString().slice(0, 10);
            return { date, ...(map.get(date) ?? emptyAgentTotals()) };
        });
    }
}

function bySize(a: AgentTotalsDto, b: AgentTotalsDto): number {
    return b.totalTokens - a.totalTokens;
}
