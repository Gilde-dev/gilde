import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { Job } from '../job/job.entity.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { Project } from '../project/project.entity.js';
import { ProjectMapper } from '../project/project.mapper.js';
import type { ReplaceProjectDto } from '../project/project.dto.js';
import { ProjectService } from '../project/project.service.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { AgentUsageService } from '../usage/agent-usage.service.js';
import { LlmUsage } from '../usage/usage.entity.js';
import { UsageService } from '../usage/usage.service.js';
import { User } from '../user/user.entity.js';

import { BudgetService, parseGlobalLimit, periodWindow } from './budget.service.js';

const DAILY = 'GLOBAL_DAILY_BUDGET_USD';
const WEEKLY = 'GLOBAL_WEEKLY_BUDGET_USD';
const SECRET = 'sk-raw-secret-value';

let ds: DataSource;
let now: Date;
let service: BudgetService;
let projects: ProjectService;

/** PUT-style replacement that keeps the stored values of everything but the budget fields in `over`. */
async function setBudget(id: string, over: Partial<Pick<ReplaceProjectDto, 'dailyBudgetUsd' | 'weeklyBudgetUsd' | 'budgetSoftPct'>>) {
    const p = await projects.getById(id);
    await projects.update(id, {
        name: p.name, description: p.description, dailyRunLimit: p.dailyRunLimit, maxAttempts: p.maxAttempts,
        runTimeoutMinutes: p.runTimeoutMinutes, retryOnChangesRequested: p.retryOnChangesRequested,
        skillsLibrary: p.skillsLibrary, skillsLibraryRepoId: p.skillsLibraryRepoId,
        dailyBudgetUsd: p.dailyBudgetUsd, weeklyBudgetUsd: p.weeklyBudgetUsd, budgetSoftPct: p.budgetSoftPct, ...over,
    });
}
let seq = 0;
let pa: string, pb: string, runA: string, runB: string;

const agent = (eventAt: string, costUsd: number | null, runId: string | null = null) =>
    ds.getRepository(AgentUsage).insert({
        runId, jobId: null, attribution: null, sessionId: 's', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd, durationMs: null, eventAt: new Date(eventAt), eventKey: `k${seq++}`, serviceVersion: null, organizationId: null,
    });
const llm = (createdAt: string, costUsd: number | null, kind: 'chat' | 'embedding' = 'chat') =>
    ds.getRepository(LlmUsage).insert({ kind, model: 'm', costUsd, createdAt: new Date(createdAt) });

beforeEach(async () => {
    delete process.env[DAILY];
    delete process.env[WEEKLY];
    now = new Date('2026-03-10T12:00:00Z'); // a Tuesday
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, Feature, AgentUsage, LlmUsage], synchronize: true,
    }).initialize();
    const pr = ds.getRepository(Project);
    pa = (await pr.save(pr.create({ slug: 'a', name: 'A' }))).id;
    pb = (await pr.save(pr.create({ slug: 'b', name: 'B' }))).id;
    const repos = ds.getRepository(Repo), jobs = ds.getRepository(Job), runs = ds.getRepository(JobRun);
    const mk = async (projectId: string, slug: string) => {
        const repo = await repos.save(repos.create({ projectId, fullName: `o/${slug}`, testCommands: ['t'] }));
        const job = await jobs.save(jobs.create({ projectId, repoId: repo.id, title: slug, task: 't' }));
        return (await runs.save(runs.create({ jobId: job.id, projectId, repoId: repo.id, attempt: 1 }))).id;
    };
    runA = await mk(pa, 'a');
    runB = await mk(pb, 'b');
    projects = new ProjectService(new ProjectMapper(), pr, repos);
    service = new BudgetService(projects, new AgentUsageService(ds.getRepository(AgentUsage)), new UsageService(ds.getRepository(LlmUsage)), () => now);
});

afterEach(async () => {
    delete process.env[DAILY];
    delete process.env[WEEKLY];
    vi.restoreAllMocks();
    await ds.destroy();
});

describe('periodWindow', () => {
    it.each([
        ['2026-03-10T12:00:00Z', '2026-03-10T00:00:00.000Z', '2026-03-11T00:00:00.000Z', '2026-03-09T00:00:00.000Z', '2026-03-16T00:00:00.000Z'],
        ['2026-03-10T00:00:00Z', '2026-03-10T00:00:00.000Z', '2026-03-11T00:00:00.000Z', '2026-03-09T00:00:00.000Z', '2026-03-16T00:00:00.000Z'],
        ['2026-03-09T23:59:59.999Z', '2026-03-09T00:00:00.000Z', '2026-03-10T00:00:00.000Z', '2026-03-09T00:00:00.000Z', '2026-03-16T00:00:00.000Z'],
        ['2026-03-08T23:59:59.999Z', '2026-03-08T00:00:00.000Z', '2026-03-09T00:00:00.000Z', '2026-03-02T00:00:00.000Z', '2026-03-09T00:00:00.000Z'], // Sunday
        ['2025-12-31T23:59:59.999Z', '2025-12-31T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2025-12-29T00:00:00.000Z', '2026-01-05T00:00:00.000Z'], // year rollover
        ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2025-12-29T00:00:00.000Z', '2026-01-05T00:00:00.000Z'],
    ])('%s', (at, dayFrom, dayTo, weekFrom, weekTo) => {
        const d = periodWindow('day', new Date(at)), w = periodWindow('week', new Date(at));
        expect([d.from.toISOString(), d.to.toISOString(), w.from.toISOString(), w.to.toISOString()]).toEqual([dayFrom, dayTo, weekFrom, weekTo]);
    });
});

describe('parseGlobalLimit', () => {
    it.each([[undefined], [''], ['   ']])('%j is unlimited', (raw) => expect(parseGlobalLimit(DAILY, raw)).toEqual({ kind: 'unlimited' }));
    it.each([['0', 0], ['10', 10], [' 2.5 ', 2.5], ['1e2', 100]])('%j is %d', (raw, value) => expect(parseGlobalLimit(DAILY, raw)).toEqual({ kind: 'limit', value }));
    it.each([['abc'], ['-1'], ['NaN'], ['Infinity'], ['1e999'], ['0x10'], ['1,5'], ['$5']])('%j is invalid', (raw) => expect(parseGlobalLimit(DAILY, raw)).toEqual({ kind: 'invalid', variable: DAILY }));
});

describe('BudgetService.status', () => {
    it('shows no rows and no limits as ok with null limit/percent', async () => {
        const s = await service.status();
        expect(s.evaluatedAt).toBe(now.toISOString());
        expect(s.project).toBeNull();
        expect(s.global.day).toMatchObject({ scope: 'global', period: 'day', spent: 0, totalRows: 0, pricing: 'empty', incomplete: false, limit: null, percent: null, state: 'ok', reason: null, startsAt: '2026-03-10T00:00:00.000Z', resetsAt: '2026-03-11T00:00:00.000Z' });
        expect(s.global.week).toMatchObject({ startsAt: '2026-03-09T00:00:00.000Z', resetsAt: '2026-03-16T00:00:00.000Z', softPct: 80 });
        expect(s).toMatchObject({ blockers: [], hardBlocked: false, recovery: 'none', recoversAt: null });
    });

    it('counts agent rows once (unattributed too) plus every llm kind globally, bounds half-open', async () => {
        await agent('2026-03-10T00:00:00.000Z', 1, runA);
        await agent('2026-03-10T01:00:00.000Z', 2, runB);
        await agent('2026-03-10T02:00:00.000Z', 4, null);
        await agent('2026-03-11T00:00:00.000Z', 1000, runA); // exactly resetsAt: next period
        await agent('2026-03-09T23:59:59.999Z', 8, runA); // yesterday: this week only
        await llm('2026-03-10T03:00:00.000Z', 0.5, 'chat');
        await llm('2026-03-10T04:00:00.000Z', 0.25, 'embedding');
        const s = await service.status();
        expect(s.global.day).toMatchObject({ spent: 7.75, pricedRows: 5, totalRows: 5, pricing: 'complete' });
        expect(s.global.week.spent).toBe(1015.75); // the Mar 11 row is still this week
    });

    it('isolates projects: attributed agent rows only, no llm, no unattributed', async () => {
        await agent('2026-03-10T01:00:00Z', 1, runA);
        await agent('2026-03-10T01:00:00Z', 2, runB);
        await agent('2026-03-10T01:00:00Z', 4, null);
        await llm('2026-03-10T01:00:00Z', 8);
        const a = await service.status(pa), b = await service.status(pb);
        expect(a.project).toMatchObject({ projectId: pa, day: { scope: 'project', projectId: pa, spent: 1, totalRows: 1 } });
        expect(b.project?.day.spent).toBe(2);
        expect(a.global.day.spent).toBe(15);
    });

    it('distinguishes true zero, unknown and partial prices', async () => {
        await agent('2026-03-10T01:00:00Z', 0, runA);
        let s = await service.status(pa);
        expect(s.project!.day).toMatchObject({ spent: 0, pricedRows: 1, pricing: 'complete', incomplete: false });
        await agent('2026-03-10T02:00:00Z', null, runA);
        s = await service.status(pa);
        expect(s.project!.day).toMatchObject({ spent: 0, pricedRows: 1, totalRows: 2, unpricedRows: 1, pricing: 'partial', incomplete: true });
        expect(s.project!.day.state).toBe('ok');
        await agent('2026-03-10T03:00:00Z', null, runB);
        expect((await service.status(pb)).project!.day).toMatchObject({ spent: 0, pricedRows: 0, totalRows: 1, pricing: 'unknown', incomplete: true });
        await llm('2026-03-10T03:00:00Z', null);
        expect((await service.status()).global.day).toMatchObject({ pricedRows: 1, totalRows: 4, unpricedRows: 3, pricing: 'partial' });
    });

    it('applies soft and hard on equality, hard wins, with unrounded costs', async () => {
        await setBudget(pa, { dailyBudgetUsd: 10, weeklyBudgetUsd: 100, budgetSoftPct: 50 });
        await agent('2026-03-10T01:00:00Z', 4.999999, runA);
        expect((await service.status(pa)).project!.day).toMatchObject({ state: 'ok', limit: 10 });
        await agent('2026-03-10T01:00:01Z', 0.000001, runA);
        let day = (await service.status(pa)).project!.day;
        expect(day).toMatchObject({ state: 'soft', percent: 50, reason: { kind: 'limit' } });
        await agent('2026-03-10T01:00:02Z', 5, runA);
        day = (await service.status(pa)).project!.day;
        expect(day).toMatchObject({ state: 'hard', spent: 10, percent: 100 });
        await agent('2026-03-10T01:00:03Z', 5, runA);
        expect((await service.status(pa)).project!.day).toMatchObject({ state: 'hard', percent: 150 });
    });

    it('treats a zero limit as hard immediately, without a non-finite percent', async () => {
        await setBudget(pa, { dailyBudgetUsd: 0 });
        const s = await service.status(pa);
        expect(s.project!.day).toMatchObject({ limit: 0, percent: null, state: 'hard', spent: 0 });
        expect(s.project!.week.state).toBe('ok');
        expect(s).toMatchObject({ hardBlocked: true, recovery: 'manual', recoversAt: null });
        process.env[DAILY] = '0';
        expect((await service.status()).global.day).toMatchObject({ limit: 0, percent: null, state: 'hard' });
    });

    it('uses an 80% global soft threshold', async () => {
        process.env[DAILY] = '10';
        await llm('2026-03-10T01:00:00Z', 7.99);
        expect((await service.status()).global.day.state).toBe('ok');
        await llm('2026-03-10T01:00:01Z', 0.01);
        expect((await service.status()).global.day).toMatchObject({ state: 'soft', percent: 80, limit: 10 });
    });

    it('keeps a hard global period while the project is fine, and reports the latest reset', async () => {
        process.env[DAILY] = '5';
        process.env[WEEKLY] = '6';
        await setBudget(pa, { dailyBudgetUsd: 100 });
        await llm('2026-03-10T01:00:00Z', 6);
        const s = await service.status(pa);
        expect(s.project!.day.state).toBe('ok');
        expect(s.blockers.map((b) => [b.scope, b.period, b.resetsAt])).toEqual([['global', 'day', '2026-03-11T00:00:00.000Z'], ['global', 'week', '2026-03-16T00:00:00.000Z']]);
        expect(s).toMatchObject({ hardBlocked: true, recovery: 'reset', recoversAt: '2026-03-16T00:00:00.000Z' });
        // Without a project the global blockers still show.
        expect((await service.status()).blockers).toHaveLength(2);
    });

    it('recovers when the next day starts, while the week keeps blocking', async () => {
        process.env[DAILY] = '5';
        process.env[WEEKLY] = '50';
        await llm('2026-03-10T01:00:00Z', 6);
        expect((await service.status()).hardBlocked).toBe(true);
        now = new Date('2026-03-11T00:00:00Z');
        const s = await service.status();
        expect(s.global.day).toMatchObject({ spent: 0, state: 'ok', startsAt: '2026-03-11T00:00:00.000Z' });
        expect(s.global.week).toMatchObject({ spent: 6, state: 'ok' });
        expect(s.hardBlocked).toBe(false);
    });

    it('rejects an unknown project with 404', async () => {
        await expect(service.status(randomUUID())).rejects.toMatchObject({ status: 404 });
    });

    it('takes one clock reading per call', async () => {
        const clock = vi.fn(() => now);
        const s = new BudgetService(projects, new AgentUsageService(ds.getRepository(AgentUsage)), new UsageService(ds.getRepository(LlmUsage)), clock);
        await s.status(pa);
        expect(clock).toHaveBeenCalledTimes(1);
    });

    it('is read-only', async () => {
        await agent('2026-03-10T01:00:00Z', 1, runA);
        const before = [await ds.getRepository(AgentUsage).count(), await ds.getRepository(Project).find()];
        await service.status(pa);
        expect([await ds.getRepository(AgentUsage).count(), await ds.getRepository(Project).find()]).toEqual(before);
    });
});

describe('invalid global configuration', () => {
    let errors: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });

    it('does not throw at startup and logs the variable but not the value', () => {
        process.env[DAILY] = SECRET;
        expect(() => service.onModuleInit()).not.toThrow();
        const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain(DAILY);
        expect(logged).not.toContain(SECRET);
        expect(logged).not.toContain(WEEKLY);
    });

    it('fails only the affected period closed with a configError, keeping spend and metadata', async () => {
        process.env[DAILY] = SECRET;
        process.env[WEEKLY] = '100';
        await llm('2026-03-10T01:00:00Z', 3);
        await llm('2026-03-10T02:00:00Z', null);
        const s = await service.status(pa);
        expect(s.global.day).toMatchObject({
            state: 'hard', limit: null, percent: null, spent: 3, pricedRows: 1, totalRows: 2, unpricedRows: 1, incomplete: true,
            startsAt: '2026-03-10T00:00:00.000Z', resetsAt: '2026-03-11T00:00:00.000Z',
            reason: { kind: 'configError', variable: DAILY },
        });
        expect(s.global.week).toMatchObject({ state: 'ok', limit: 100, reason: null });
        expect(JSON.stringify(s)).not.toContain(SECRET);
        expect(s.blockers).toEqual([expect.objectContaining({ scope: 'global', period: 'day', kind: 'configError', variable: DAILY })]);
        expect(s).toMatchObject({ hardBlocked: true, recovery: 'manual', recoversAt: null });
        expect(s.project!.day.state).toBe('ok');
    });

    it('reports both variables, and coexists with other hard blockers', async () => {
        process.env[DAILY] = 'nope';
        process.env[WEEKLY] = '-3';
        await setBudget(pa, { dailyBudgetUsd: 1 });
        await agent('2026-03-10T01:00:00Z', 2, runA);
        const s = await service.status(pa);
        expect(s.blockers.map((b) => `${b.scope}/${b.period}/${b.kind}`)).toEqual(['global/day/configError', 'global/week/configError', 'project/day/limit']);
        expect(s.recovery).toBe('manual');
        expect(s.recoversAt).toBeNull();
        const text = errors.mock.calls.map((c) => String(c[0])).join('\n');
        expect(text).toContain(DAILY);
        expect(text).toContain(WEEKLY);
        expect(text).not.toContain('nope');
        expect(text).not.toContain('-3');
    });

    it('is not fixed by a period reset, and recovers on the next evaluation once corrected', async () => {
        process.env[DAILY] = 'bad';
        expect((await service.status()).global.day.state).toBe('hard');
        now = new Date('2026-03-11T00:00:00Z');
        expect((await service.status()).global.day).toMatchObject({ state: 'hard', reason: { kind: 'configError' } });
        process.env[DAILY] = '10';
        expect((await service.status()).global.day).toMatchObject({ state: 'ok', limit: 10, reason: null });
        process.env[DAILY] = '  ';
        expect((await service.status()).global.day).toMatchObject({ state: 'ok', limit: null });
    });

    it('recovery is subject to other blockers', async () => {
        process.env[DAILY] = 'bad';
        process.env[WEEKLY] = '1';
        await llm('2026-03-10T01:00:00Z', 2);
        process.env[DAILY] = '100';
        const s = await service.status();
        expect(s.blockers.map((b) => b.period)).toEqual(['week']);
        expect(s).toMatchObject({ recovery: 'reset', recoversAt: '2026-03-16T00:00:00.000Z' });
    });

    it('logs an unchanged invalid variable once, and again after it was fixed and broke again', async () => {
        process.env[DAILY] = 'bad';
        await service.status();
        await service.status();
        expect(errors).toHaveBeenCalledTimes(1);
        process.env[DAILY] = '1';
        await service.status();
        process.env[DAILY] = 'bad again';
        await service.status();
        expect(errors).toHaveBeenCalledTimes(2);
    });
});
