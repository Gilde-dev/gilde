import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataSource, EntityManager } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import type { JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { JobMapper } from '../job/job.mapper.js';
import { JobService } from '../job/job.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { User } from '../user/user.entity.js';

import { ScoutActivityService } from './scout-activity.service.js';
import { ScoutSuggestionGuard } from './scout-suggestion-guard.entity.js';
import { ScoutSuggestion } from './scout-suggestion.entity.js';
import { canonicalEvidence, evidenceHash, ScoutSuggestionService, SUGGESTION_MARKER, utcWeekStartDay, type SuggestionInput } from './scout-suggestion.service.js';
import { issueScoutBinding } from './verkenner.context.js';

const BOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEATURE_P1 = 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1';
const FEATURE_P2 = 'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2';
const LESSON_P1 = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const LESSON_P2 = 'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2';
const RUN_P1 = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
const RUN_P2 = 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('ScoutSuggestionService', () => {
    let dir: string;
    let ds: DataSource;
    let clock: Date;
    let p1: Project;
    let p2: Project;
    let repo1: Repo;
    let repo2: Repo;
    let job1: Job;
    let foreignJob: Job;
    let jobService: JobService;
    let service: ScoutSuggestionService;

    const entities = [User, Project, Repo, Job, JobDependency, Feature, JobRevision, ScoutSuggestion, ScoutSuggestionGuard];
    const jobsRepo = () => ds.getRepository(Job);

    async function build(quota = 3): Promise<ScoutSuggestionService> {
        const repos = ds.getRepository(Repo);
        jobService = new JobService(new JobMapper(), { getById: (id: string) => repos.findOneByOrFail({ id }) } as never, {} as never, {} as never, jobsRepo(), ds.getRepository(JobDependency), ds.getRepository(Feature));
        const find = (map: Record<string, string>) => async (id: string) => { if (!map[id]) throw new Error('not found'); return { id, projectId: map[id] }; };
        return new ScoutSuggestionService(
            ds, jobService,
            { getById: find({ [FEATURE_P1]: p1.id, [FEATURE_P2]: p2.id }) } as never,
            { getById: find({ [LESSON_P1]: p1.id, [LESSON_P2]: p2.id }) } as never,
            { findById: async (id: string) => ({ [RUN_P1]: p1.id, [RUN_P2]: p2.id })[id] ? { id, projectId: ({ [RUN_P1]: p1.id, [RUN_P2]: p2.id })[id] } : null } as never,
            { getById: (id: string) => repos.findOneByOrFail({ id }) },
            { user: { id: BOT }, dailySuggestions: quota },
            () => clock,
        );
    }

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'scout-suggest-'));
        clock = new Date('2026-10-27T12:00:00Z'); // a Tuesday
        ds = await new DataSource({ type: 'better-sqlite3', database: join(dir, 'app.db'), entities, synchronize: true }).initialize();
        await ds.getRepository(User).insert({ id: BOT, name: 'Verkenner', email: 'verkenner@example.com', password: 'x' });
        const projects = ds.getRepository(Project);
        p1 = await projects.save(projects.create({ slug: 'p1', name: 'P1' }));
        p2 = await projects.save(projects.create({ slug: 'p2', name: 'P2' }));
        const repos = ds.getRepository(Repo);
        repo1 = await repos.save(repos.create({ projectId: p1.id, fullName: 'o/a', testCommands: ['x'] }));
        repo2 = await repos.save(repos.create({ projectId: p2.id, fullName: 'o/b', testCommands: ['x'] }));
        job1 = await seed(repo1, 'merged', 'Evidence job');
        foreignJob = await seed(repo2, 'merged', 'Foreign job');
        service = await build();
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await ds.destroy();
        rmSync(dir, { recursive: true, force: true });
    });

    const seed = (repo: Repo, status: JobStatus, title: string) =>
        jobsRepo().save(jobsRepo().create({ projectId: repo.projectId, repoId: repo.id, title, task: 'some task text', status }));
    const binding = (projectId = () => p1.id) => issueScoutBinding(BOT, projectId());
    let n = 0;
    const input = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({
        repoId: repo1.id, title: `Suggestion ${++n}`, task: 'Add the missing follow-up for the recurring problem.', acceptanceCriteria: ['It is done and tested'],
        reason: 'Three runs failed on the same step.', basedOn: [job1.id], ...over,
    });
    const jobCount = () => jobsRepo().count();
    const receipts = () => ds.getRepository(ScoutSuggestion).find();
    const fresh = (i: number) => `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

    it('creates exactly one triage job by the scout with a Why section, the evidence ids and the marker, and a receipt', async () => {
        const before = await jobCount();
        const res = await service.suggest(binding(), input({ title: '  Fix flaky step ', basedOn: [job1.id, FEATURE_P1, RUN_P1, LESSON_P1] }));
        expect(res).toMatchObject({ created: true, status: 'triage' });
        if (!res.created) throw new Error('unreachable');
        expect(await jobCount()).toBe(before + 1);
        const job = await jobsRepo().findOneByOrFail({ id: res.jobId });
        expect(job).toMatchObject({ status: 'triage', createdById: BOT, projectId: p1.id, featureId: null, queuedAt: null, title: 'Fix flaky step' });
        expect(await ds.getRepository(JobDependency).count({ where: { jobId: job.id } })).toBe(0);
        const ids = canonicalEvidence([job1.id, FEATURE_P1, RUN_P1, LESSON_P1]);
        expect(job.task).toMatch(/^Add the missing follow-up/);
        expect(job.task.endsWith(`## Why\nThree runs failed on the same step.\n\nBased on: ${ids.join(', ')}\n\n${SUGGESTION_MARKER}`)).toBe(true);
        expect(await receipts()).toEqual([expect.objectContaining({ projectId: p1.id, jobId: job.id, actorId: BOT, evidenceHash: evidenceHash(ids), day: '2026-10-27' })]);
    });

    it('refuses while the scout is off', async () => {
        const off = new ScoutSuggestionService(ds, jobService, {} as never, {} as never, {} as never, {} as never, null, () => clock);
        const res = await off.suggest(binding(), input());
        expect(res).toMatchObject({ created: false, stop: true, refusal: { reason: 'scout_off' } });
        expect(await receipts()).toHaveLength(0);
    });

    it('refuses spoofed contexts: a look-alike binding, a binding of another user, no binding', async () => {
        const lookAlike = { ...binding() };
        for (const b of [lookAlike, JSON.parse(JSON.stringify(binding())), issueScoutBinding('someone-else', p1.id), null, undefined]) {
            expect(await service.suggest(b, input())).toMatchObject({ created: false, refusal: { reason: 'untrusted_context' } });
        }
        expect(await receipts()).toHaveLength(0);
        expect(await jobCount()).toBe(2);
    });

    it.each([
        ['empty basedOn', [], 'missing_evidence'],
        ['blank basedOn', ['  ', ''], 'missing_evidence'],
        ['malformed id', ['not-an-id'], 'invalid_evidence'],
        ['unknown id', [UNKNOWN], 'invalid_evidence'],
        ['foreign job', [foreignId('job')], 'foreign_evidence'],
        ['foreign feature', [FEATURE_P2], 'foreign_evidence'],
        ['foreign lesson', [LESSON_P2], 'foreign_evidence'],
        ['foreign run', [RUN_P2], 'foreign_evidence'],
    ])('refuses %s without any state change', async (_name, basedOn, reason) => {
        const evidence = basedOn.map((id) => (id === 'foreign-job' ? foreignJob.id : id));
        const before = await jobCount();
        const res = await service.suggest(binding(), input({ basedOn: evidence }));
        expect(res).toMatchObject({ created: false, stop: true, refusal: { reason } });
        expect(await jobCount()).toBe(before);
        expect(await receipts()).toHaveLength(0);
        expect(await ds.getRepository(ScoutSuggestionGuard).count()).toBe(0);
    });
    function foreignId(kind: string) { return `foreign-${kind}`; }

    it('refuses a repo of another project and an unknown repo, and good evidence mixed with a foreign id', async () => {
        expect(await service.suggest(binding(), input({ repoId: repo2.id }))).toMatchObject({ refusal: { reason: 'foreign_repo' } });
        expect(await service.suggest(binding(), input({ repoId: UNKNOWN }))).toMatchObject({ refusal: { reason: 'unknown_repo' } });
        const mixed = await service.suggest(binding(), input({ basedOn: [job1.id, foreignJob.id] }));
        expect(mixed).toMatchObject({ refusal: { reason: 'foreign_evidence', ids: [foreignJob.id] } });
        expect(await jobCount()).toBe(2);
    });

    it('validates the job limits, including the assembled task, and never consumes the allowance', async () => {
        for (const bad of [input({ title: 'ab' }), input({ task: 'short' }), input({ acceptanceCriteria: ['x'] }), input({ reason: 'no' }), input({ basedOn: [fresh(1), ...Array.from({ length: 25 }, (_, i) => fresh(i + 2))] })]) {
            expect(await service.suggest(binding(), bad)).toMatchObject({ refusal: { reason: expect.stringMatching(/invalid_input|invalid_evidence/) } });
        }
        expect(await jobCount()).toBe(2);
        for (let i = 0; i < 3; i++) expect(await service.suggest(binding(), input({ basedOn: [job1.id, ...(i ? [FEATURE_P1] : []), ...(i > 1 ? [RUN_P1] : [])] }))).toMatchObject({ created: true });
    });

    it('hashes the sorted unique evidence set: order, repeats and case do not matter', async () => {
        expect(evidenceHash([FEATURE_P1, job1.id])).toBe(evidenceHash([job1.id.toUpperCase(), FEATURE_P1, job1.id]));
        expect(evidenceHash([job1.id])).not.toBe(evidenceHash([job1.id, FEATURE_P1]));
        const first = await service.suggest(binding(), input({ basedOn: [FEATURE_P1, job1.id] }));
        if (!first.created) throw new Error('unreachable');
        const again = await service.suggest(binding(), input({ basedOn: [job1.id, FEATURE_P1, job1.id.toUpperCase()] }));
        expect(again).toMatchObject({ created: false, stop: true, refusal: { reason: 'duplicate_evidence', ids: [first.jobId] } });
        expect(await receipts()).toHaveLength(1);
    });

    it('keeps refusing an evidence set after its job was cancelled, merged or even deleted, and on later days', async () => {
        const first = await service.suggest(binding(), input({ basedOn: [job1.id] }));
        if (!first.created) throw new Error('unreachable');
        for (const change of [() => jobsRepo().update({ id: first.jobId }, { status: 'cancelled' }), () => jobsRepo().update({ id: first.jobId }, { status: 'merged' }), () => jobsRepo().delete({ id: first.jobId })]) {
            await change();
            expect(await service.suggest(binding(), input({ basedOn: [job1.id] }))).toMatchObject({ refusal: { reason: 'duplicate_evidence' } });
        }
        clock = new Date('2026-11-20T01:00:00Z');
        expect(await service.suggest(binding(), input({ basedOn: [job1.id] }))).toMatchObject({ refusal: { reason: 'duplicate_evidence' } });
    });

    it.each<JobStatus>(['triage', 'queued', 'dispatched', 'pr_open', 'awaiting_review', 'parked'])('refuses the title of a %s job, ignoring case and spaces', async (status) => {
        const open = await seed(repo1, status, 'Fix The Flaky Step');
        const res = await service.suggest(binding(), input({ title: '  fix the FLAKY step  ' }));
        expect(res).toMatchObject({ created: false, stop: true, refusal: { reason: 'duplicate_title', ids: [open.id] } });
        expect(await receipts()).toHaveLength(0);
    });

    it.each<JobStatus>(['merged', 'rejected', 'cancelled'])('accepts the title of a %s job, and ignores the title of another project', async (status) => {
        await seed(repo1, status, 'Reused Title');
        await seed(repo2, 'parked', 'Other Project Title');
        expect(await service.suggest(binding(), input({ title: 'reused title' }))).toMatchObject({ created: true });
        expect(await service.suggest(binding(), input({ title: 'other project title', basedOn: [job1.id, FEATURE_P1] }))).toMatchObject({ created: true });
    });

    it('finds an open title in a project with more than the public list limit of jobs', async () => {
        await jobsRepo().insert(Array.from({ length: 210 }, (_, i) => ({ projectId: p1.id, repoId: repo1.id, title: `Filler ${i}`, task: 'filler task text', status: 'merged' as const })));
        const open = await seed(repo1, 'parked', 'Oldest parked');
        for (let i = 0; i < 205; i++) await seed(repo1, 'merged', `Later ${i}`);
        expect(await service.suggest(binding(), input({ title: 'OLDEST PARKED' }))).toMatchObject({ refusal: { reason: 'duplicate_title', ids: [open.id] } });
    });

    it('enforces the daily quota (default three) per project and resets at UTC midnight', async () => {
        const create = (i: number) => service.suggest(binding(), input({ basedOn: [fresh(i), job1.id].slice(i === 0 ? 1 : 0) }));
        // distinct evidence sets that all resolve: only real ids are accepted, so combine the real ones
        const sets = [[job1.id], [job1.id, FEATURE_P1], [job1.id, RUN_P1], [job1.id, LESSON_P1]];
        void create;
        clock = new Date('2026-10-27T23:59:59.999Z');
        for (const set of sets.slice(0, 3)) expect(await service.suggest(binding(), input({ basedOn: set }))).toMatchObject({ created: true });
        const refused = await service.suggest(binding(), input({ basedOn: sets[3] }));
        expect(refused).toMatchObject({ created: false, stop: true, refusal: { reason: 'daily_limit' } });
        expect(await receipts()).toHaveLength(3);
        clock = new Date('2026-10-28T00:00:00.000Z');
        expect(await service.suggest(binding(), input({ basedOn: sets[3] }))).toMatchObject({ created: true });
        // another project has its own allowance
        expect(await ds.getRepository(ScoutSuggestion).countBy({ projectId: p2.id })).toBe(0);
    });

    it('survives a restart: a new service instance on the same database sees quota, hashes and titles', async () => {
        for (const set of [[job1.id], [job1.id, FEATURE_P1], [job1.id, RUN_P1]]) await service.suggest(binding(), input({ basedOn: set }));
        await ds.destroy();
        ds = await new DataSource({ type: 'better-sqlite3', database: join(dir, 'app.db'), entities, synchronize: true }).initialize();
        const restarted = await build();
        expect(await restarted.suggest(binding(), input({ basedOn: [job1.id, LESSON_P1] }))).toMatchObject({ refusal: { reason: 'daily_limit' } });
        clock = new Date('2026-10-28T08:00:00Z');
        expect(await restarted.suggest(binding(), input({ basedOn: [job1.id] }))).toMatchObject({ refusal: { reason: 'duplicate_evidence' } });
        expect(await receipts()).toHaveLength(3);
    });

    it('rolls the job back when the receipt cannot be written, and a retry then creates exactly one', async () => {
        const real = EntityManager.prototype.insert;
        const spy = vi.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (this: EntityManager, target: unknown, ...rest: never[]) {
            if (target === ScoutSuggestion) return Promise.reject(new Error('disk full'));
            return (real as (...a: unknown[]) => Promise<unknown>).call(this, target, ...rest) as never;
        });
        const before = await jobCount();
        await expect(service.suggest(binding(), input())).rejects.toThrow('disk full');
        expect(await jobCount()).toBe(before);
        expect(await receipts()).toHaveLength(0);
        spy.mockRestore();
        expect(await service.suggest(binding(), input())).toMatchObject({ created: true });
        expect(await jobCount()).toBe(before + 1);
        expect(await receipts()).toHaveLength(1);
    });

    describe('concurrent callers', () => {
        const REAL = () => [[job1.id], [job1.id, FEATURE_P1], [job1.id, RUN_P1], [job1.id, LESSON_P1], [job1.id, FEATURE_P1, RUN_P1]];

        it('never exceed the quota on the last slots, even with several service instances', async () => {
            const second = await build();
            const results = await Promise.all(REAL().map((set, i) => (i % 2 ? service : second).suggest(binding(), input({ basedOn: set }))));
            expect(results.filter((r) => r.created)).toHaveLength(3);
            expect(results.filter((r) => !r.created && r.refusal.reason === 'daily_limit')).toHaveLength(2);
            expect(await receipts()).toHaveLength(3);
            expect(await jobsRepo().count({ where: { createdById: BOT } })).toBe(3);
        });

        it('create one job for the same evidence set', async () => {
            const second = await build();
            const results = await Promise.all([0, 1, 2, 3].map((i) => (i % 2 ? service : second).suggest(binding(), input({ basedOn: i % 2 ? [job1.id, FEATURE_P1] : [FEATURE_P1, job1.id] }))));
            expect(results.filter((r) => r.created)).toHaveLength(1);
            expect(results.filter((r) => !r.created && r.refusal.reason === 'duplicate_evidence')).toHaveLength(3);
            expect(await jobsRepo().count({ where: { createdById: BOT } })).toBe(1);
        });

        it('create one job for the same title in any casing', async () => {
            const second = await build();
            const sets = REAL();
            const titles = ['Same Title', 'same title', ' SAME TITLE ', 'Same title'];
            const results = await Promise.all(titles.map((title, i) => (i % 2 ? service : second).suggest(binding(), input({ title, basedOn: sets[i] }))));
            expect(results.filter((r) => r.created)).toHaveLength(1);
            expect(results.filter((r) => !r.created && r.refusal.reason === 'duplicate_title')).toHaveLength(3);
        });
    });

    it('has no way to enqueue, edit, cancel or start: it only calls JobService.create, with triage and no dependencies or feature', async () => {
        const create = vi.spyOn(jobService, 'create');
        const forbidden = ['enqueue', 'enqueueMany', 'update', 'cancel', 'retry', 'toTriage', 'setDependencies'].map((m) => vi.spyOn(jobService as never, m as never));
        await service.suggest(binding(), input());
        expect(create).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith(repo1.id, expect.objectContaining({ status: 'triage' }), { id: BOT }, expect.anything());
        const dto = create.mock.calls[0][1];
        expect(dto.dependsOn).toBeUndefined();
        expect(dto.featureId).toBeUndefined();
        for (const f of forbidden) expect(f).not.toHaveBeenCalled();
    });

    describe('activity', () => {
        const activity = (wakes: Date | null = null, scout = { enabled: true, model: 'openai/m' as string | null, userId: BOT as string | null }) =>
            new ScoutActivityService(ds.getRepository(ScoutSuggestion), { lastWakeAt: async () => wakes }, { getById: async (id: string) => ({ id }) } as never, { findByEmail: async () => ({ id: BOT }) } as never, scout, () => 'bot@example.com', () => clock);

        it('counts suggestions from Monday 00:00 UTC through now, for the selected project only', async () => {
            const insert = (day: string, projectId = p1.id, hash = Math.random().toString(16)) =>
                ds.getRepository(ScoutSuggestion).insert({ projectId, jobId: UNKNOWN, actorId: BOT, evidenceHash: hash.padEnd(64, '0'), day, createdAt: new Date(`${day}T00:00:00Z`) });
            await insert('2026-10-25'); // Sunday of the previous week
            await insert('2026-10-26'); // Monday 00:00
            await insert('2026-10-27');
            await insert('2026-10-26', p2.id);
            expect(utcWeekStartDay(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-26');
            expect(utcWeekStartDay(new Date('2026-11-01T23:59:59Z'))).toBe('2026-10-26');
            expect(utcWeekStartDay(new Date('2026-11-02T00:00:00Z'))).toBe('2026-11-02');
            expect(await activity().get(p1.id)).toMatchObject({ suggestionsThisWeek: 2, weekStart: '2026-10-26', lastWakeAt: null });
            expect(await activity().get(p2.id)).toMatchObject({ suggestionsThisWeek: 1 });
            clock = new Date('2026-11-02T00:00:00Z'); // the next Monday: a new week
            expect(await activity().get(p1.id)).toMatchObject({ suggestionsThisWeek: 0, weekStart: '2026-11-02' });
        });

        it('reports the actual last wake, history while off, and the scout user without the bot email', async () => {
            const wake = new Date('2026-10-27T06:00:00Z');
            const off = await activity(wake, { enabled: false, model: null, userId: null }).get(p1.id);
            expect(off).toEqual({ projectId: p1.id, enabled: false, model: null, scoutUserId: BOT, suggestionsThisWeek: 0, weekStart: '2026-10-26', lastWakeAt: wake.toISOString() });
            expect(JSON.stringify(off)).not.toContain('@');
        });
    });
});
