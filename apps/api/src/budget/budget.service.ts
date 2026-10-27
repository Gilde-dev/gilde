import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ProjectService } from '../project/project.service.js';
import type { ProjectResponseDto } from '../project/project.dto.js';
import { AgentUsageService } from '../usage/agent-usage.service.js';
import { UsageService } from '../usage/usage.service.js';

import {
    GLOBAL_BUDGET_VARIABLES,
    type BudgetBlocker, type BudgetPeriod, type BudgetPeriodStatus, type BudgetPricing, type BudgetReason, type BudgetScope, type BudgetStatusDto,
} from './budget.dto.js';

/** One clock reading per status call; override the provider to control time. */
export const BUDGET_CLOCK = Symbol('BUDGET_CLOCK');
export type BudgetClock = () => Date;

export const GLOBAL_SOFT_PCT = 80;
const DAY_MS = 86_400_000;

type GlobalLimit = { kind: 'unlimited' } | { kind: 'limit'; value: number } | { kind: 'invalid'; variable: string };

const NUMBER = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Unset or blank = unlimited; a finite non-negative number = limit; anything else = invalid. Never throws. */
export function parseGlobalLimit(variable: string, raw: string | undefined): GlobalLimit {
    const text = raw?.trim() ?? '';
    if (text === '') return { kind: 'unlimited' };
    if (!NUMBER.test(text)) return { kind: 'invalid', variable };
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? { kind: 'limit', value } : { kind: 'invalid', variable };
}

/** The UTC day and ISO week (Monday start) containing `now`, as [startsAt, resetsAt). */
export function periodWindow(period: BudgetPeriod, now: Date): { from: Date; to: Date } {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (period === 'day') return { from: new Date(today), to: new Date(today + DAY_MS) };
    const sinceMonday = (now.getUTCDay() + 6) % 7;
    const monday = today - sinceMonday * DAY_MS;
    return { from: new Date(monday), to: new Date(monday + 7 * DAY_MS) };
}

interface Spend { spent: number; pricedRows: number; totalRows: number }

/**
 * Evaluates recorded (estimated) spend against budgets. Read-only: it only calls usage and project services.
 * Global spend is every `agent_usage` row once (attributed or not) plus every `llm_usage` row; project spend is the
 * agent rows attributed to one of its runs. Global limits come from the environment and are re-read on every call;
 * an invalid explicit value makes that global period `hard` with a `configError` reason instead of failing.
 */
@Injectable()
export class BudgetService implements OnModuleInit {
    private readonly logger = new Logger('Budget');
    /** Variables already reported as invalid, so a poll does not log the same error every time. */
    private readonly reported = new Set<string>();

    constructor(
        private readonly projects: ProjectService,
        private readonly agentUsage: AgentUsageService,
        private readonly usage: UsageService,
        @Inject(BUDGET_CLOCK) private readonly clock: BudgetClock,
    ) { }

    /** Reports a bad global configuration at startup; never throws, the API starts regardless. */
    onModuleInit(): void {
        try {
            this.globalLimits();
        } catch (error) {
            this.logger.error(`Reading the global budget configuration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }

    async status(projectId?: string): Promise<BudgetStatusDto> {
        const now = this.clock();
        const project = projectId ? await this.projects.getById(projectId) : null;
        const limits = this.globalLimits();

        const [globalDay, globalWeek, projectDay, projectWeek] = await Promise.all([
            this.globalPeriod('day', now, limits.day),
            this.globalPeriod('week', now, limits.week),
            project ? this.projectPeriod('day', now, project) : null,
            project ? this.projectPeriod('week', now, project) : null,
        ]);

        const all = [globalDay, globalWeek, ...(projectDay && projectWeek ? [projectDay, projectWeek] : [])];
        const blockers = all.filter((p) => p.state === 'hard').map(toBlocker);
        const manual = blockers.some((b) => b.kind === 'configError' || b.limit === 0);
        const latest = blockers.reduce<string | null>((max, b) => (max === null || b.resetsAt > max ? b.resetsAt : max), null);

        return {
            evaluatedAt: now.toISOString(),
            global: { day: globalDay, week: globalWeek },
            project: project && projectDay && projectWeek ? { projectId: project.id, day: projectDay, week: projectWeek } : null,
            blockers,
            hardBlocked: blockers.length > 0,
            recovery: blockers.length === 0 ? 'none' : manual ? 'manual' : 'reset',
            recoversAt: blockers.length === 0 || manual ? null : latest,
        };
    }

    private globalLimits(): { day: GlobalLimit; week: GlobalLimit } {
        const limits = {
            day: parseGlobalLimit(GLOBAL_BUDGET_VARIABLES.day, process.env[GLOBAL_BUDGET_VARIABLES.day]),
            week: parseGlobalLimit(GLOBAL_BUDGET_VARIABLES.week, process.env[GLOBAL_BUDGET_VARIABLES.week]),
        };
        for (const limit of Object.values(limits)) {
            if (limit.kind === 'invalid') {
                if (this.reported.has(limit.variable)) continue;
                this.reported.add(limit.variable);
                // Names the variable only: the raw value could be a secret pasted into the wrong place.
                this.logger.error(`Invalid configuration: ${limit.variable} is not a finite, non-negative number. New automatic dispatch is stopped (fail closed) until it is corrected or removed.`);
            }
        }
        for (const name of Object.values(GLOBAL_BUDGET_VARIABLES)) {
            if (parseGlobalLimit(name, process.env[name]).kind !== 'invalid') this.reported.delete(name);
        }
        return limits;
    }

    private async globalPeriod(period: BudgetPeriod, now: Date, limit: GlobalLimit): Promise<BudgetPeriodStatus> {
        const { from, to } = periodWindow(period, now);
        const [agent, llm] = await Promise.all([this.agentUsage.totals({ from, to }), this.usage.costBetween(from, to)]);
        const spend: Spend = {
            spent: (agent.costUsd ?? 0) + llm.knownCostUsd,
            pricedRows: agent.runs - agent.costUnknownRequests + llm.pricedRows,
            totalRows: agent.runs + llm.totalRows,
        };
        return evaluate('global', period, null, from, to, spend, limit.kind === 'limit' ? limit.value : null, GLOBAL_SOFT_PCT,
            limit.kind === 'invalid' ? configError(limit.variable) : null);
    }

    private async projectPeriod(period: BudgetPeriod, now: Date, project: ProjectResponseDto): Promise<BudgetPeriodStatus> {
        const { from, to } = periodWindow(period, now);
        const agent = await this.agentUsage.totals({ projectId: project.id, from, to });
        const spend: Spend = { spent: agent.costUsd ?? 0, pricedRows: agent.runs - agent.costUnknownRequests, totalRows: agent.runs };
        return evaluate('project', period, project.id, from, to, spend, period === 'day' ? project.dailyBudgetUsd : project.weeklyBudgetUsd, project.budgetSoftPct, null);
    }
}

function configError(variable: string): BudgetReason {
    return {
        kind: 'configError',
        variable,
        message: `${variable} is set but not a finite, non-negative number. New automatic dispatch is stopped until it is corrected or removed; a period reset does not clear this.`,
    };
}

function evaluate(
    scope: BudgetScope, period: BudgetPeriod, projectId: string | null, from: Date, to: Date,
    spend: Spend, limit: number | null, softPct: number, error: BudgetReason | null,
): BudgetPeriodStatus {
    const unpricedRows = spend.totalRows - spend.pricedRows;
    const pricing: BudgetPricing = spend.totalRows === 0 ? 'empty' : unpricedRows === 0 ? 'complete' : spend.pricedRows === 0 ? 'unknown' : 'partial';
    const percent = limit !== null && limit > 0 ? (spend.spent / limit) * 100 : null;

    let state: BudgetPeriodStatus['state'] = 'ok';
    let reason: BudgetReason | null = null;
    const label = `${scope === 'global' ? 'Global' : 'Project'} ${period === 'day' ? 'daily' : 'weekly'}`;
    if (error) {
        state = 'hard';
        reason = error;
    } else if (limit !== null) {
        if (limit === 0 || spend.spent >= limit) {
            state = 'hard';
            reason = { kind: 'limit', variable: null, message: limit === 0 ? `${label} estimated budget is 0: new automatic dispatch is stopped.` : `${label} estimated budget reached.` };
        } else if (spend.spent >= (limit * softPct) / 100) {
            state = 'soft';
            reason = { kind: 'limit', variable: null, message: `${label} estimated budget passed ${softPct}%.` };
        }
    }
    return {
        scope, period, projectId,
        startsAt: from.toISOString(), resetsAt: to.toISOString(),
        spent: spend.spent, pricedRows: spend.pricedRows, totalRows: spend.totalRows, unpricedRows, pricing, incomplete: unpricedRows > 0,
        limit: error ? null : limit, percent: error ? null : percent, softPct, state, reason,
    };
}

function toBlocker(p: BudgetPeriodStatus): BudgetBlocker {
    return {
        scope: p.scope, projectId: p.projectId, period: p.period,
        kind: p.reason?.kind ?? 'limit', variable: p.reason?.variable ?? null,
        limit: p.limit, spent: p.spent, startsAt: p.startsAt, resetsAt: p.resetsAt, message: p.reason?.message ?? '',
    };
}
