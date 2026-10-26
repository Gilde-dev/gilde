import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository, type FindOptionsWhere } from 'typeorm';

import { User } from '../user/user.entity.js';

import type { UsageQuery, UsageRecord, UsageResponseDto, UsageTotalsDto } from './usage.dto.js';
import { LlmUsage } from './usage.entity.js';
import { computeCost, parsePrices } from './usage-pricing.js';

const DAY_MS = 86_400_000;

const emptyTotals = (): UsageTotalsDto => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: null, runs: 0 });

function add(t: UsageTotalsDto, row: LlmUsage): void {
    t.inputTokens += row.inputTokens;
    t.cachedInputTokens += row.cachedInputTokens;
    t.outputTokens += row.outputTokens;
    t.reasoningTokens += row.reasoningTokens;
    t.totalTokens += row.inputTokens + row.outputTokens;
    t.runs++;
    if (row.costUsd !== null) t.costUsd = (t.costUsd ?? 0) + row.costUsd;
}

function group<K extends string | null, T extends object>(rows: LlmUsage[], key: (r: LlmUsage) => K, extra: (k: K, r: LlmUsage) => T): (UsageTotalsDto & T)[] {
    const map = new Map<K, UsageTotalsDto & T>();
    for (const r of rows) {
        const k = key(r);
        let entry = map.get(k);
        if (!entry) map.set(k, (entry = { ...emptyTotals(), ...extra(k, r) }));
        add(entry, r);
    }
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

@Injectable()
export class UsageService {
    private readonly logger = new Logger('Usage');

    constructor(@InjectRepository(LlmUsage) private readonly usage: Repository<LlmUsage>) { }

    /** Best effort: stores one usage row and never throws, so chat and indexing are never affected. */
    async record(record: UsageRecord): Promise<void> {
        try {
            const inputTokens = record.inputTokens ?? 0;
            const cachedInputTokens = record.cachedInputTokens ?? 0;
            const outputTokens = record.outputTokens ?? 0;
            await this.usage.save(this.usage.create({
                kind: record.kind,
                model: record.model,
                userId: record.userId ?? null,
                threadId: record.threadId ?? null,
                agent: record.agent ?? null,
                steps: record.steps ?? null,
                inputTokens,
                cachedInputTokens,
                outputTokens,
                reasoningTokens: record.reasoningTokens ?? 0,
                costUsd: computeCost(parsePrices(process.env.LLM_PRICES), record.model, { inputTokens, cachedInputTokens, outputTokens }),
            }));
        } catch (error) {
            this.logger.warn(`Recording LLM usage failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async summary(q: UsageQuery, now: Date = new Date()): Promise<UsageResponseDto> {
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const start = new Date(today.getTime() - (q.days - 1) * DAY_MS);
        const where: FindOptionsWhere<LlmUsage> = { createdAt: MoreThanOrEqual(start) };
        if (q.userId) where.userId = q.userId;
        if (q.kind) where.kind = q.kind;
        const rows = await this.usage.find({ where });

        const names = new Map((await this.usage.manager.getRepository(User).find({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));

        const totals = emptyTotals();
        rows.forEach((r) => add(totals, r));

        const byDay = new Map<string, UsageTotalsDto>();
        for (let i = 0; i < q.days; i++) byDay.set(new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10), emptyTotals());
        for (const r of rows) {
            const day = byDay.get(r.createdAt.toISOString().slice(0, 10));
            if (day) add(day, r);
        }

        return {
            days: q.days,
            totals,
            daily: [...byDay].map(([date, t]) => ({ date, ...t })),
            byModel: group(rows, (r) => r.model, (model) => ({ model })),
            byKind: group(rows, (r) => r.kind, (kind) => ({ kind })),
            byUser: group(rows, (r) => r.userId, (userId) => ({ userId, userName: userId ? names.get(userId) ?? null : null })),
        };
    }
}
