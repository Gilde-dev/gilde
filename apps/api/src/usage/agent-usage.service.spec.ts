import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { Job } from '../job/job.entity.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';

import { agentWindow, AgentUsageService } from './agent-usage.service.js';

let ds: DataSource;
let service: AgentUsageService;
let seq = 0;
const ids = {} as { pa: string; pb: string; ra: string; rb: string; f: string; job1: string; job2: string; run1: string; run2: string; run3: string };

async function row(over: Partial<AgentUsage>) {
    await ds.getRepository(AgentUsage).save(ds.getRepository(AgentUsage).create({
        runId: null, jobId: null, attribution: null, sessionId: 's', model: 'm1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20,
        costUsd: 0.5, durationMs: null, eventAt: new Date('2026-03-10T10:00:00Z'), eventKey: `k${seq++}`, serviceVersion: null, organizationId: null, ...over,
    }));
}

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, Feature, AgentUsage], synchronize: true,
    }).initialize();
    const projects = ds.getRepository(Project);
    const pa = await projects.save(projects.create({ slug: 'a', name: 'A' }));
    const pb = await projects.save(projects.create({ slug: 'b', name: 'B' }));
    const repos = ds.getRepository(Repo);
    const ra = await repos.save(repos.create({ projectId: pa.id, fullName: 'o/a', testCommands: ['t'] }));
    const rb = await repos.save(repos.create({ projectId: pb.id, fullName: 'o/b', testCommands: ['t'] }));
    const feature = await ds.getRepository(Feature).save(ds.getRepository(Feature).create({ projectId: pa.id, title: 'Feat', spec: 's' }));
    const jobs = ds.getRepository(Job);
    const j1 = await jobs.save(jobs.create({ projectId: pa.id, repoId: ra.id, featureId: feature.id, title: 'j1', task: 't' }));
    const j2 = await jobs.save(jobs.create({ projectId: pb.id, repoId: rb.id, title: 'j2', task: 't' }));
    const runs = ds.getRepository(JobRun);
    const mk = (job: Job, attempt: number) => runs.save(runs.create({ jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt }));
    const [r1, r2, r3] = [await mk(j1, 1), await mk(j1, 2), await mk(j2, 1)];
    Object.assign(ids, { pa: pa.id, pb: pb.id, ra: ra.id, rb: rb.id, f: feature.id, job1: j1.id, job2: j2.id, run1: r1.id, run2: r2.id, run3: r3.id });
    service = new AgentUsageService(ds.getRepository(AgentUsage));
});

afterEach(async () => { await ds.destroy(); });

describe('AgentUsageService', () => {
    it('is empty and null-cost without rows', async () => {
        expect(await service.totals()).toMatchObject({ totalTokens: 0, runs: 0, costUsd: null, costPartial: false });
        expect((await service.byDay(agentWindow(3, new Date('2026-03-10T12:00:00Z')))).map((d) => d.runs)).toEqual([0, 0, 0]);
    });

    it('keeps token categories separate and inclusive input/total semantics', async () => {
        await row({ runId: ids.run1, jobId: ids.job1 });
        expect(await service.totals()).toEqual({
            inputTokens: 130, cachedInputTokens: 100, cacheCreationTokens: 20, outputTokens: 5, reasoningTokens: 0, totalTokens: 135,
            costUsd: 0.5, runs: 1, uncachedInputTokens: 10, costUnknownRequests: 0, costPartial: false,
        });
    });

    it('reconciles run, job, feature, repo and unattributed totals', async () => {
        await row({ runId: ids.run1, jobId: ids.job1 });
        await row({ runId: ids.run2, jobId: ids.job1, model: 'm2' });
        await row({ runId: ids.run3, jobId: ids.job2 });
        await row({ runId: null });
        const all = await service.totals();
        expect(all.runs).toBe(4);
        const byRun = await service.forRuns([ids.run1, ids.run2, ids.run3]);
        expect(byRun.get(ids.run1)!.runs).toBe(1);
        expect((await service.forJobs([ids.job1])).get(ids.job1)!.runs).toBe(2);
        expect((await service.forFeatures([ids.f])).get(ids.f)!.runs).toBe(2);
        expect((await service.forRuns([])).size).toBe(0);
        const repos = await service.byRepo();
        expect(repos.map((r) => [r.fullName, r.runs]).sort()).toEqual([['o/a', 2], ['o/b', 1]]);
        expect((await service.byFeature()).map((f) => [f.title, f.runs])).toEqual([['Feat', 2]]);
        expect((await service.byModel()).map((m) => [m.model, m.runs]).sort()).toEqual([['m1', 3], ['m2', 1]]);
        const unattributed = await service.unattributed();
        expect(unattributed.runs).toBe(1);
        const attributed = (await service.totals({ projectId: ids.pa })).runs + (await service.totals({ projectId: ids.pb })).runs;
        expect(attributed + unattributed.runs).toBe(all.runs);
    });

    it('scopes by the attributed run project; unattributed rows never join a project', async () => {
        await row({ runId: ids.run1, jobId: ids.job1 });
        await row({ runId: null });
        expect((await service.totals({ projectId: ids.pa })).runs).toBe(1);
        expect((await service.totals({ projectId: ids.pb })).runs).toBe(0);
        expect((await service.totals()).runs).toBe(2);
        expect((await service.byModel({ projectId: ids.pa }))[0].runs).toBe(1);
    });

    it('distinguishes null, zero and partially unknown costs without recalculating', async () => {
        await row({ runId: ids.run1, jobId: ids.job1, costUsd: null });
        expect((await service.totals()).costUsd).toBeNull();
        await row({ runId: ids.run1, jobId: ids.job1, costUsd: 0 });
        expect(await service.totals()).toMatchObject({ costUsd: 0, costUnknownRequests: 1, costPartial: true });
        await row({ runId: ids.run2, jobId: ids.job1, costUsd: 0.25 });
        expect((await service.forRuns([ids.run2])).get(ids.run2)).toMatchObject({ costUsd: 0.25, costPartial: false });
        expect((await service.totals()).costUsd).toBe(0.25);
    });

    it('groups by UTC event date, zero-fills the window and excludes outside it', async () => {
        await row({ eventAt: new Date('2026-03-10T23:59:59.999Z') });
        await row({ eventAt: new Date('2026-03-09T00:00:00.000Z') });
        await row({ eventAt: new Date('2026-03-07T23:59:59.999Z') }); // before a 3-day window ending 03-10
        const window = agentWindow(3, new Date('2026-03-10T05:00:00Z'));
        const daily = await service.byDay(window);
        expect(daily.map((d) => [d.date, d.runs])).toEqual([['2026-03-08', 0], ['2026-03-09', 1], ['2026-03-10', 1]]);
        expect((await service.totals({ from: window.from, to: window.to })).runs).toBe(2);
        expect((await service.totals()).runs).toBe(3); // lifetime differs from the window
    });
});
