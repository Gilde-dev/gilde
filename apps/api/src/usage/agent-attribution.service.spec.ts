import { CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { Job } from '../job/job.entity.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';

import { AgentAttributionService } from './agent-attribution.service.js';

const MIN = 60_000;
const NOW = new Date('2026-03-10T12:00:00.000Z');
const at = (offsetMin: number, extraMs = 0) => new Date(NOW.getTime() + offsetMin * MIN + extraMs);

let ds: DataSource;
let usage: Repository<AgentUsage>;
let runs: Repository<JobRun>;
let service: AgentAttributionService;
let projectA: Project;
let projectB: Project;
let repoA: Repo;
let repoB: Repo;
let seq = 0;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, Feature, AgentUsage], synchronize: true,
    }).initialize();
    usage = ds.getRepository(AgentUsage);
    runs = ds.getRepository(JobRun);
    projectA = await ds.getRepository(Project).save(ds.getRepository(Project).create({ slug: 'a', name: 'A' }));
    projectB = await ds.getRepository(Project).save(ds.getRepository(Project).create({ slug: 'b', name: 'B' }));
    repoA = await ds.getRepository(Repo).save(ds.getRepository(Repo).create({ projectId: projectA.id, fullName: 'o/a', testCommands: ['t'] }));
    repoB = await ds.getRepository(Repo).save(ds.getRepository(Repo).create({ projectId: projectB.id, fullName: 'o/b', testCommands: ['t'] }));
    service = new AgentAttributionService(usage, runs);
    service.clock = () => NOW;
});

afterEach(async () => { await ds.destroy(); });

async function run(over: Partial<JobRun> & { project?: 'a' | 'b' } = {}): Promise<JobRun> {
    const { project = 'a', ...rest } = over;
    return runs.save(runs.create({
        jobId: randomUUID(), projectId: (project === 'a' ? projectA : projectB).id, repoId: (project === 'a' ? repoA : repoB).id,
        attempt: 1, status: 'fired', sessionId: null, firedAt: null, finishedAt: null, ...rest,
    }));
}

async function row(sessionId: string, eventAt: Date, over: Partial<AgentUsage> = {}): Promise<AgentUsage> {
    return usage.save(usage.create({
        runId: null, jobId: null, attribution: null, sessionId, model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: null, durationMs: null, eventAt, eventKey: `k${seq++}`, serviceVersion: null, organizationId: null, ...over,
    }));
}

const reload = async (id: string) => (await usage.findOneByOrFail({ id }));

describe('AgentAttributionService', () => {
    it('is wired to the five-minute schedule', () => {
        expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', AgentAttributionService.prototype.scheduled)).toMatchObject({ cronTime: CronExpression.EVERY_5_MINUTES });
    });

    describe('quiet delay', () => {
        it('only processes sessions whose latest event is strictly older than ten minutes', async () => {
            await run({ sessionId: 's-edge' });
            const edge = await row('s-edge', at(-10));
            const quiet = await row('s-edge2', at(-10, -1));
            const exact2 = await run({ sessionId: 's-edge2' });
            const r = await service.attribute();
            expect((await reload(edge.id)).runId).toBeNull();
            expect((await reload(quiet.id)).runId).toBe(exact2.id);
            expect(r.sessionsExamined).toBe(1);
        });

        it('a recent event keeps the whole session, assigned or unassigned rows, unprocessed', async () => {
            const exact = await run({ sessionId: 's1' });
            const old = await row('s1', at(-60));
            const assigned = await row('s1', at(-50), { runId: exact.id, jobId: exact.jobId, attribution: 'time_window' });
            await row('s1', at(-1));
            const r = await service.attribute();
            expect(r.sessionsExamined).toBe(0);
            expect((await reload(old.id)).runId).toBeNull();
            expect((await reload(assigned.id)).attribution).toBe('time_window');
        });
    });

    describe('exact match', () => {
        it('wins over the start window, across projects and with no start restriction', async () => {
            const exact = await run({ sessionId: 's1', project: 'b', firedAt: at(-600) });
            await run({ firedAt: at(-61) });
            const a = await row('s1', at(-60));
            const r = await service.attribute();
            const saved = await reload(a.id);
            expect(saved).toMatchObject({ runId: exact.id, jobId: exact.jobId, attribution: 'session' });
            expect(r).toMatchObject({ sessionsBySession: 1, rowsAttributed: 1 });
        });

        it('stays ambiguous for duplicate exact ids and does not fall back', async () => {
            await run({ sessionId: 's1' });
            await run({ sessionId: 's1' });
            await run({ firedAt: at(-61) });
            const a = await row('s1', at(-60));
            const r = await service.attribute();
            expect((await reload(a.id)).runId).toBeNull();
            expect(r.sessionsAmbiguous).toBe(1);
        });

        it('matches regardless of finishedAt and run status', async () => {
            const exact = await run({ sessionId: 's1', status: 'fire_failed', finishedAt: at(-1000) });
            const a = await row('s1', at(-60));
            await service.attribute();
            expect((await reload(a.id)).runId).toBe(exact.id);
        });
    });

    describe('start-time fallback', () => {
        const T = at(-60);

        it('attributes the one run fired in the window', async () => {
            const candidate = await run({ firedAt: at(-65) });
            const a = await row('s1', T);
            const r = await service.attribute();
            expect(await reload(a.id)).toMatchObject({ runId: candidate.id, jobId: candidate.jobId, attribution: 'time_window' });
            expect(r).toMatchObject({ sessionsByTimeWindow: 1, rowsAttributed: 1 });
        });

        it('includes firedAt exactly at T-10m and at T, and excludes just outside either bound', async () => {
            for (const [fired, expected] of [[at(-70), true], [at(-60), true], [at(-70, -1), false], [at(-60, 1), false]] as const) {
                const c = await run({ firedAt: fired });
                const a = await row(`s-${fired.getTime()}`, T);
                await service.attribute();
                expect((await reload(a.id)).runId).toBe(expected ? c.id : null);
                await runs.delete({ id: c.id });
                await usage.clear();
            }
        });

        it('treats two runs fired 30 seconds apart as ambiguous, including across projects', async () => {
            await run({ firedAt: at(-65), project: 'a' });
            await run({ firedAt: at(-65, 30_000), project: 'b' });
            const a = await row('s1', T);
            const r = await service.attribute();
            expect((await reload(a.id)).runId).toBeNull();
            expect(r.sessionsAmbiguous).toBe(1);
        });

        it('leaves a session starting 20 minutes after the only firedAt unattributed, even if the PR is still open', async () => {
            await run({ firedAt: at(-80), finishedAt: null });
            const a = await row('s1', T);
            const r = await service.attribute();
            expect((await reload(a.id)).runId).toBeNull();
            expect(r.sessionsUnmatched).toBe(1);
        });

        it('ignores an older long-open run outside the window and runs without firedAt', async () => {
            await run({ firedAt: at(-60 * 24), finishedAt: null });
            await run({ firedAt: null });
            const candidate = await run({ firedAt: at(-62) });
            const a = await row('s1', T);
            await service.attribute();
            expect((await reload(a.id)).runId).toBe(candidate.id);
        });

        it('never looks at finishedAt', async () => {
            const candidate = await run({ firedAt: at(-62), finishedAt: at(-1000) });
            const a = await row('s1', T);
            await service.attribute();
            expect((await reload(a.id)).runId).toBe(candidate.id);
            await usage.update({ id: a.id }, { runId: null, jobId: null, attribution: null });
            await runs.update({ id: candidate.id }, { finishedAt: null });
            await service.attribute();
            expect((await reload(a.id)).runId).toBe(candidate.id);
        });

        it('uses the MIN event time over all rows, whatever the insert order', async () => {
            const early = await run({ firedAt: at(-72) });
            await run({ firedAt: at(-58) }); // only in [T-10m, T] when T is wrongly the later row
            await row('s1', at(-50));
            const first = await row('s1', at(-62));
            await row('s1', at(-55));
            await service.attribute();
            expect((await reload(first.id)).runId).toBe(early.id);
        });
    });

    describe('provenance, backfill and freezing', () => {
        it('backfills in bounded batches over repeated passes and is idempotent', async () => {
            const candidate = await run({ firedAt: at(-65) });
            const ids: string[] = [];
            for (let i = 0; i < 3; i++) ids.push((await row(`s${i}`, at(-60 - i * 30))).id);
            await row('s-late', at(-200)); // earlier than the run's window: stays unattributed
            const first = await service.attribute();
            const second = await service.attribute();
            expect(first.rowsAttributed).toBe(1);
            expect(second.rowsAttributed).toBe(0);
            expect((await reload(ids[0])).runId).toBe(candidate.id);
        });

        it('does not run concurrently and the second call reports skipped', async () => {
            const candidate = await run({ firedAt: at(-65) });
            const a = await row('s1', at(-60));
            const [x, y] = await Promise.all([service.attribute(), service.attribute()]);
            expect([x.skipped, y.skipped].sort()).toEqual([false, true]);
            expect((await reload(a.id)).runId).toBe(candidate.id);
            expect((await service.attribute()).skipped).toBe(false);
        });

        it('a unique exact match later upgrades time_window rows, replacing run and job', async () => {
            const windowRun = await run({ firedAt: at(-65) });
            const a = await row('s1', at(-60));
            await service.attribute();
            expect((await reload(a.id)).attribution).toBe('time_window');
            const exact = await run({ sessionId: 's1', project: 'b' });
            const r = await service.attribute();
            expect(await reload(a.id)).toMatchObject({ runId: exact.id, jobId: exact.jobId, attribution: 'session' });
            expect(r.rowsUpgraded).toBe(1);
            expect(windowRun.id).not.toBe(exact.id);
        });

        it('freezes fallback rows when candidates change or earlier late events arrive, but a late row waits then joins its own window', async () => {
            const first = await run({ firedAt: at(-65) });
            const a = await row('s1', at(-60));
            await service.attribute();
            await run({ firedAt: at(-66) }); // second candidate appears: existing row must not move or clear
            const early = await row('s1', at(-300)); // late, earlier event: new T has no candidate
            expect((await reload(early.id)).runId).toBeNull();
            const r = await service.attribute();
            expect((await reload(a.id))).toMatchObject({ runId: first.id, attribution: 'time_window' });
            expect((await reload(early.id)).runId).toBeNull();
            expect(r.rowsUpgraded).toBe(0);
        });

        it('never changes session assignments', async () => {
            const exact = await run({ sessionId: 's1' });
            const a = await row('s1', at(-60));
            await service.attribute();
            const other = await run({ sessionId: 's1' }); // now ambiguous
            await service.attribute();
            expect(await reload(a.id)).toMatchObject({ runId: exact.id, attribution: 'session' });
            expect(other.id).not.toBe(exact.id);
        });
    });
});
