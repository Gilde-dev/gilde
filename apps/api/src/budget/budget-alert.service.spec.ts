import { Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Notification } from '../notification/notification.entity.js';
import { NotificationMapper } from '../notification/notification.mapper.js';
import { NotificationService } from '../notification/notification.service.js';

import { BudgetAlertService, occurrenceKey } from './budget-alert.service.js';
import type { BudgetPeriodStatus, BudgetState, BudgetStatusDto } from './budget.dto.js';

const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const P2 = '4a2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5d';
const DAY = { startsAt: '2026-03-10T00:00:00.000Z', resetsAt: '2026-03-11T00:00:00.000Z' };
const WEEK = { startsAt: '2026-03-09T00:00:00.000Z', resetsAt: '2026-03-16T00:00:00.000Z' };

function period(scope: 'global' | 'project', p: 'day' | 'week', state: BudgetState, over: Partial<BudgetPeriodStatus> = {}, projectId: string | null = null): BudgetPeriodStatus {
    return {
        scope, period: p, projectId: scope === 'project' ? (projectId ?? P1) : null, ...(p === 'day' ? DAY : WEEK),
        spent: state === 'ok' ? 1 : 8.1, pricedRows: 2, totalRows: 2, unpricedRows: 0, pricing: 'complete', incomplete: false,
        limit: state === 'ok' ? null : 10, percent: state === 'ok' ? null : 81, softPct: 80, state,
        reason: state === 'ok' ? null : { kind: 'limit', variable: null, message: `${scope} ${p} ${state}` }, ...over,
    };
}

function status(parts: { gd?: BudgetState; gw?: BudgetState; pd?: BudgetState; pw?: BudgetState; projectId?: string }): BudgetStatusDto {
    const projectId = parts.projectId ?? P1;
    return {
        evaluatedAt: '2026-03-10T12:00:00.000Z',
        global: { day: period('global', 'day', parts.gd ?? 'ok'), week: period('global', 'week', parts.gw ?? 'ok') },
        project: parts.pd || parts.pw ? { projectId, day: period('project', 'day', parts.pd ?? 'ok', {}, projectId), week: period('project', 'week', parts.pw ?? 'ok', {}, projectId) } : null,
        blockers: [], hardBlocked: false, recovery: 'none', recoversAt: null,
    };
}

describe('BudgetAlertService (real notification outbox on SQLite)', () => {
    let ds: DataSource;
    let rows: Repository<Notification>;
    let budget: { status: ReturnType<typeof vi.fn> };
    let projects: { list: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn> };
    const make = () => new BudgetAlertService(budget as never, new NotificationService(rows, new NotificationMapper()), projects as never);
    const budgeted = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Proj ${id.slice(0, 2)}`, dailyBudgetUsd: 10, weeklyBudgetUsd: null, ...over });
    const keys = async () => (await rows.find()).map((r) => r.occurrenceKey).sort();

    beforeEach(async () => {
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Notification], synchronize: true }).initialize();
        rows = ds.getRepository(Notification);
        budget = { status: vi.fn().mockResolvedValue(status({})) };
        projects = { list: vi.fn().mockResolvedValue([]), getById: vi.fn().mockImplementation(async (id: string) => ({ id, name: `Proj ${id.slice(0, 2)}` })) };
    });
    afterEach(() => ds.destroy());

    it('records a soft crossing as budget.soft with the structured facts and no job, PR or repo data', async () => {
        budget.status.mockResolvedValue(status({ gd: 'soft' }));
        expect(await make().evaluateAll()).toEqual({ recorded: 1 });
        const [row] = await rows.find();
        expect(row).toMatchObject({
            kind: 'budget.soft', occurrenceKey: `budget.soft:global:day:${DAY.startsAt}`, status: 'pending', projectId: null,
            jobId: null, featureId: null, repos: [], prLinks: [], title: 'Budget Gilde',
            budget: { scope: 'global', period: 'day', state: 'soft', spent: 8.1, limit: 10, percent: 81, resetsAt: DAY.resetsAt, unpricedRows: 0, reasonKind: 'limit' },
        });
        expect(row.deliveredAt).toBeNull();
    });

    it('records hard without inventing a prior soft crossing, and a later hard after soft is a second occurrence', async () => {
        budget.status.mockResolvedValue(status({ gd: 'hard' }));
        await make().evaluateAll();
        expect(await keys()).toEqual([`budget.hard:global:day:${DAY.startsAt}`]);

        await rows.clear();
        budget.status.mockResolvedValue(status({ gw: 'soft' }));
        await make().evaluateAll();
        budget.status.mockResolvedValue(status({ gw: 'hard' }));
        await make().evaluateAll();
        expect(await keys()).toEqual([`budget.hard:global:week:${WEEK.startsAt}`, `budget.soft:global:week:${WEEK.startsAt}`]);
    });

    it('evaluates with no queued work and records nothing while everything is ok', async () => {
        projects.list.mockResolvedValue([budgeted(P1)]);
        expect(await make().evaluateAll()).toEqual({ recorded: 0 });
        expect(await rows.count()).toBe(0);
        expect(budget.status).toHaveBeenCalledWith();
        expect(budget.status).toHaveBeenCalledWith(P1);
    });

    it('dedupes durably across repeated evaluations, a restart (new instance), concurrent instances and oscillation', async () => {
        budget.status.mockResolvedValue(status({ gd: 'hard' }));
        await Promise.all([make().evaluateAll(), make().evaluateAll(), make().evaluateAll()]);
        await make().evaluateAll();
        budget.status.mockResolvedValue(status({ gd: 'ok' }));
        await make().evaluateAll();
        budget.status.mockResolvedValue(status({ gd: 'hard' }));
        await make().evaluateAll();
        expect(await rows.count()).toBe(1);
    });

    it('does not re-emit when the limit is edited within the same period, but emits again in the next period', async () => {
        budget.status.mockResolvedValue(status({ gd: 'soft' }));
        await make().evaluateAll();
        budget.status.mockResolvedValue(status({ gd: 'ok' })); // limit raised
        await make().evaluateAll();
        budget.status.mockResolvedValue(status({ gd: 'soft' })); // lowered again
        await make().evaluateAll();
        expect(await rows.count()).toBe(1);

        const next = status({ gd: 'soft' });
        next.global.day = { ...next.global.day, startsAt: DAY.resetsAt, resetsAt: '2026-03-12T00:00:00.000Z' };
        budget.status.mockResolvedValue(next);
        await make().evaluateAll();
        expect(await rows.count()).toBe(2);
    });

    it('keeps scopes, projects, periods and kinds apart, and records the global scope once however many projects exist', async () => {
        projects.list.mockResolvedValue([budgeted(P1), budgeted(P2, { dailyBudgetUsd: null, weeklyBudgetUsd: 5 })]);
        budget.status.mockImplementation(async (id?: string) => (id ? status({ projectId: id, gd: 'hard', pd: 'soft', pw: 'hard' }) : status({ gd: 'hard', gw: 'soft' })));
        await make().evaluateAll();
        const all = await keys();
        expect(all).toEqual([
            `budget.hard:${P1}:week:${WEEK.startsAt}`,
            `budget.hard:${P2}:week:${WEEK.startsAt}`,
            `budget.hard:global:day:${DAY.startsAt}`,
            `budget.soft:${P1}:day:${DAY.startsAt}`,
            `budget.soft:${P2}:day:${DAY.startsAt}`,
            `budget.soft:global:week:${WEEK.startsAt}`,
        ].sort());
        const project = await rows.findOneByOrFail({ occurrenceKey: `budget.hard:${P1}:week:${WEEK.startsAt}` });
        expect(project).toMatchObject({ projectId: P1, title: 'Budget Proj 3f', budget: { scope: 'project', period: 'week' } });
    });

    it('skips projects without any configured limit', async () => {
        projects.list.mockResolvedValue([budgeted(P1, { dailyBudgetUsd: null, weeklyBudgetUsd: null })]);
        await make().evaluateAll();
        expect(budget.status).toHaveBeenCalledTimes(1);
    });

    it('carries the configError reason and unpriced counts for the Slack explanation', async () => {
        const s = status({});
        s.global.day = period('global', 'day', 'hard', { limit: null, percent: null, unpricedRows: 3, incomplete: true, reason: { kind: 'configError', variable: 'GLOBAL_DAILY_BUDGET_USD', message: 'invalid' } });
        budget.status.mockResolvedValue(s);
        await make().evaluateAll();
        expect((await rows.findOneByOrFail({ kind: 'budget.hard' })).budget).toMatchObject({ reasonKind: 'configError', variable: 'GLOBAL_DAILY_BUDGET_USD', unpricedRows: 3, limit: null });
    });

    it('never throws: one failing evaluation does not stop the others and no notification is invented', async () => {
        const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        projects.list.mockResolvedValue([budgeted(P1), budgeted(P2)]);
        budget.status.mockImplementation(async (id?: string) => {
            if (!id) throw new Error('usage db down');
            if (id === P1) throw new Error('boom');
            return status({ projectId: id, pd: 'hard' });
        });
        await expect(make().evaluateAll()).resolves.toEqual({ recorded: 1 });
        expect(await keys()).toEqual([`budget.hard:${P2}:day:${DAY.startsAt}`]);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    it('survives storage failures while capturing', async () => {
        const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const service = make();
        await ds.query('DROP TABLE notifications');
        await expect(service.capture(status({ gd: 'hard' }))).resolves.toBe(0);
        error.mockRestore();
    });

    it('skips an evaluation that starts while another one runs in this process', async () => {
        let release: () => void = () => undefined;
        budget.status.mockImplementation(() => new Promise((resolve) => { release = () => resolve(status({ gd: 'hard' })); }));
        const service = make();
        const first = service.evaluateAll();
        expect(await service.evaluateAll()).toEqual({ recorded: 0 });
        release();
        expect(await first).toEqual({ recorded: 1 });
    });

    it('builds the key from scope, period, canonical UTC start and kind only', () => {
        expect(occurrenceKey(period('project', 'week', 'hard', {}, P1))).toBe(`budget.hard:${P1}:week:${WEEK.startsAt}`);
    });
});
