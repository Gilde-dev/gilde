import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { NotificationBudget } from '../notification/notification.entity.js';
import { NotificationService } from '../notification/notification.service.js';
import { ProjectService } from '../project/project.service.js';

import type { BudgetPeriodStatus, BudgetStatusDto } from './budget.dto.js';
import { BudgetService } from './budget.service.js';

/** Projects evaluated per batch of the scheduled pass. */
export const ALERT_BATCH_SIZE = 20;

/**
 * Records budget.soft / budget.hard in the durable notification outbox. One occurrence per scope, period, canonical UTC
 * period start and kind: the unique occurrence key makes retries, restarts, concurrent evaluations and limit edits record
 * at most once. Nothing here throws, so a notification problem never changes what a stop decision was.
 */
@Injectable()
export class BudgetAlertService {
    private readonly logger = new Logger('BudgetAlerts');
    private running = false;

    constructor(
        private readonly budget: BudgetService,
        private readonly notifications: NotificationService,
        private readonly projects: ProjectService,
    ) { }

    /** Every minute, independent of queued work. A pass that starts while another runs in this process is skipped. */
    @Cron(CronExpression.EVERY_MINUTE)
    async scheduled(): Promise<void> {
        await this.evaluateAll();
    }

    /** Evaluates the global scope once, then every project with a configured limit, in batches. */
    async evaluateAll(): Promise<{ recorded: number }> {
        if (this.running) return { recorded: 0 };
        this.running = true;
        let recorded = 0;
        try {
            try {
                recorded += await this.capture(await this.budget.status(), 'global');
            } catch (e) {
                this.logger.error(`Global budget evaluation failed: ${errorMessage(e)}`);
            }
            let list: Awaited<ReturnType<ProjectService['list']>> = [];
            try {
                list = (await this.projects.list()).filter((p) => p.dailyBudgetUsd !== null || p.weeklyBudgetUsd !== null);
            } catch (e) {
                this.logger.error(`Listing projects for the budget evaluation failed: ${errorMessage(e)}`);
            }
            for (let i = 0; i < list.length; i += ALERT_BATCH_SIZE) {
                for (const project of list.slice(i, i + ALERT_BATCH_SIZE)) {
                    try {
                        recorded += await this.capture(await this.budget.status(project.id), 'project');
                    } catch (e) {
                        this.logger.error(`Budget evaluation of project ${project.id} failed: ${errorMessage(e)}`);
                    }
                }
            }
        } finally {
            this.running = false;
        }
        return { recorded };
    }

    /**
     * Records the soft or hard occurrence of every period of `status` within `scopes` ('all' = global and project).
     * Hard wins over soft; an already hard period records hard without a prior soft. Returns how many rows were new.
     */
    async capture(status: BudgetStatusDto, scopes: 'global' | 'project' | 'all' = 'all'): Promise<number> {
        const periods: BudgetPeriodStatus[] = [];
        if (scopes !== 'project') periods.push(status.global.day, status.global.week);
        if (scopes !== 'global' && status.project) periods.push(status.project.day, status.project.week);
        let recorded = 0;
        const names = new Map<string, string>();
        for (const p of periods) {
            if (p.state === 'ok') continue;
            try {
                const created = await this.notifications.recordQuietly(async () => ({
                    occurrenceKey: occurrenceKey(p),
                    kind: p.state === 'hard' ? 'budget.hard' : 'budget.soft',
                    occurredAt: new Date(status.evaluatedAt),
                    projectId: p.projectId,
                    title: `Budget ${p.projectId ? await this.projectName(p.projectId, names) : 'Gilde'}`,
                    repos: [],
                    reason: p.reason?.message ?? '',
                    prLinks: [],
                    budget: toBudget(p),
                }));
                if (created) recorded++;
            } catch (e) {
                this.logger.error(`Recording the ${p.state} budget notification failed: ${errorMessage(e)}`);
            }
        }
        return recorded;
    }

    private async projectName(id: string, cache: Map<string, string>): Promise<string> {
        const cached = cache.get(id);
        if (cached !== undefined) return cached;
        const name = await this.projects.getById(id).then((p) => p.name, () => id);
        cache.set(id, name);
        return name;
    }
}

/** `budget.<state>:<global|projectId>:<period>:<UTC period start>`: stable identity, never the clock reading. */
export function occurrenceKey(p: BudgetPeriodStatus): string {
    return `budget.${p.state}:${p.projectId ?? 'global'}:${p.period}:${p.startsAt}`;
}

function toBudget(p: BudgetPeriodStatus): NotificationBudget {
    return {
        scope: p.scope, period: p.period, state: p.state === 'hard' ? 'hard' : 'soft',
        spent: p.spent, limit: p.limit, percent: p.percent, startsAt: p.startsAt, resetsAt: p.resetsAt,
        unpricedRows: p.unpricedRows, reasonKind: p.reason?.kind ?? 'limit', variable: p.reason?.variable ?? null,
    };
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
