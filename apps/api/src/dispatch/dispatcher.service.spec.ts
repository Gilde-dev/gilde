import { Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionError } from '../execution/execution.error.js';
import { User } from '../user/user.entity.js';
import { Feature } from '../feature/feature.entity.js';
import type { ExecutionPort } from '../execution/execution.port.js';
import { prepareJobPrompt } from '../execution/job-prompt.js';
import type { JobStatus } from '../job/job-state.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { Project } from '../project/project.entity.js';
import { RepoMapper } from '../repo/repo.mapper.js';
import { Repo } from '../repo/repo.entity.js';
import { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { RunMapper } from '../run/run.mapper.js';
import { RunService } from '../run/run.service.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { Notification } from '../notification/notification.entity.js';
import { NotificationMapper } from '../notification/notification.mapper.js';
import { NotificationService } from '../notification/notification.service.js';
import { DispatchController } from './dispatch.controller.js';
import { DispatcherService } from './dispatcher.service.js';

let ds: DataSource;
let fire: ReturnType<typeof vi.fn>;
let dispatcher: DispatcherService;
let projects: Repository<Project>;
let repos: Repository<Repo>;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let repoService: RepoService;
let searchLessons: ReturnType<typeof vi.fn>;
let notifications: Repository<Notification>;
let budget: { status: ReturnType<typeof vi.fn> };
let budgetAlerts: { capture: ReturnType<typeof vi.fn> };

beforeEach(async () => {
    instructionsText = null;
    prepareFailure = null;
    ds = await new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [User, Project, Repo, Job, JobRun, JobDependency, Feature, JobRevision, Notification],
        synchronize: true,
    }).initialize();
    projects = ds.getRepository(Project);
    repos = ds.getRepository(Repo);
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    budget = { status: vi.fn().mockResolvedValue({ hardBlocked: false, blockers: [], recovery: 'none', recoversAt: null }) };
    budgetAlerts = { capture: vi.fn().mockResolvedValue(0) };
    searchLessons = vi.fn().mockResolvedValue({ status: 'ok', lessons: [] });
    fire = vi.fn().mockResolvedValue({ sessionId: 's1', sessionUrl: 'https://x/s1' });
    const execution = fakeExecution();
    repoService = new RepoService(new RepoMapper(), {} as never, repos);
    notifications = ds.getRepository(Notification);
    const capture = new NotificationCaptureService(new NotificationService(notifications, new NotificationMapper()), repos, jobs, ds.getRepository(Feature));
    dispatcher = new DispatcherService(new RunService(new RunMapper(), runs), execution, jobs, repos, projects, runs, repoService, ds.getRepository(Feature), { searchLessons } as never, budget as never, budgetAlerts as never, capture);
});

afterEach(() => ds.destroy());

/** The real renderer with the instructions in `instructionsText`; `fire` sees the final payload, as before. */
let instructionsText: string | null = null;
let prepareFailure: Error | null = null;
function fakeExecution(): ExecutionPort {
    return {
        prepare: (p, c) => {
            if (prepareFailure) throw prepareFailure;
            return prepareJobPrompt(p, { text: instructionsText, version: null }, c);
        },
        fire: (r, input) => fire(r, 'prepared' in input ? input.payload : input) as ReturnType<ExecutionPort['fire']>,
    };
}

let seq = 0;
async function seedProject(over: Partial<Project> = {}) {
    seq++;
    return projects.save(projects.create({ slug: `p${seq}`, name: `P${seq}`, ...over }));
}
async function seedRepo(project: Project, over: Partial<Repo> = {}) {
    seq++;
    return repos.save(repos.create({
        projectId: project.id,
        fullName: `o/r${seq}`,
        stacks: ['node'],
        testCommands: ['pnpm test'],
        routineFireUrl: 'https://fire',
        routineTokenEnv: 'TOKEN',
        ...over,
    }));
}
let t = 0;
async function seedJob(repo: Repo, status: JobStatus = 'queued', over: Partial<Job> = {}) {
    return jobs.save(jobs.create({
        projectId: repo.projectId, repoId: repo.id, title: 'T', task: 'do', acceptanceCriteria: ['a'],
        status, queuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, t++)), ...over,
    }));
}
const reload = (id: string) => jobs.findOneByOrFail({ id });

describe('DispatcherService', () => {
    it('skips repos without a cached manifest and reports the manifest error', async () => {
        const repo = await seedRepo(await seedProject(), { testCommands: [], stacks: [], manifestError: '.gilde.json not found on main' });
        await seedJob(repo);
        const result = await dispatcher.dispatch();
        expect(result).toMatchObject({ fired: 0, failed: 0 });
        expect(fire).not.toHaveBeenCalled();
        expect(result.repos[0]).toMatchObject({ reason: 'no_manifest', detail: '.gilde.json not found on main', queued: 1 });
    });

    it('never fires triage jobs', async () => {
        const repo = await seedRepo(await seedProject());
        const triage = await seedJob(repo, 'triage', { queuedAt: null });
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 0 });
        expect(fire).not.toHaveBeenCalled();
        expect((await reload(triage.id)).status).toBe('triage');
    });

    describe('dependencies', () => {
        const link = (job: Job, dep: Job) => ds.getRepository(JobDependency).save({ jobId: job.id, dependsOnJobId: dep.id });

        it('does not fire a job with an unmerged dependency, and fires it once merged', async () => {
            const repo = await seedRepo(await seedProject());
            const dep = await seedJob(repo, 'pr_open');
            const job = await seedJob(repo);
            await link(job, dep);

            expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 0 });
            expect(fire).not.toHaveBeenCalled();

            await jobs.update({ id: dep.id }, { status: 'merged' });
            expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });
            expect((await reload(job.id)).status).toBe('dispatched');
        });

        it('lets a newer unblocked job fire past an older blocked one, and reports the waiting count', async () => {
            const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 1 });
            const dep = await seedJob(repo, 'pr_open', { queuedAt: new Date(Date.UTC(2025, 0, 1)) });
            const blocked = await seedJob(repo);
            const free = await seedJob(repo);
            await link(blocked, dep);
            // dep is pr_open (active) but repo has 2 slots worth of room only if we raise it
            await repos.update({ id: repo.id }, { maxConcurrentJobs: 2 });
            const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

            const result = await dispatcher.dispatch();
            expect(result).toMatchObject({ fired: 1, failed: 0 });
            expect((await reload(free.id)).status).toBe('dispatched');
            expect((await reload(blocked.id)).status).toBe('queued');
            expect(result.repos[0]).toMatchObject({ waitingOnDependencies: 1 });
            expect(log).not.toHaveBeenCalledWith(expect.stringContaining('queued job(s) waiting'));
        });
    });

    it('fires a queued job with the full payload and records the run', async () => {
        const repo = await seedRepo(await seedProject());
        const job = await seedJob(repo);

        expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });

        expect(fire).toHaveBeenCalledOnce();
        const [execRepo, payload] = fire.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(execRepo).toMatchObject({ fullName: repo.fullName, routineFireUrl: 'https://fire' });
        const run = await runs.findOneByOrFail({ jobId: job.id });
        expect(payload).toEqual({
            gilde: 1, jobId: job.id, runId: run.id, attempt: 1, repo: repo.fullName, baseBranch: 'main',
            title: 'T', task: 'do', acceptanceCriteria: ['a'], testCommands: ['pnpm test'], stacks: ['node'],
        });
        expect(run).toMatchObject({ status: 'fired', sessionId: 's1', sessionUrl: 'https://x/s1', attempt: 1 });
        expect(await reload(job.id)).toMatchObject({ status: 'dispatched', attempts: 1 });
    });

    it('stores the instructions version the fire used on the run', async () => {
        fire.mockResolvedValue({ sessionId: 's1', sessionUrl: 'https://x/s1', instructionsVersion: 'abc123def456' });
        const repo = await seedRepo(await seedProject());
        const job = await seedJob(repo);
        await dispatcher.dispatch();
        expect(await runs.findOneByOrFail({ jobId: job.id })).toMatchObject({ status: 'fired', instructionsVersion: 'abc123def456' });
    });

    it('sends continueOn only when the job has a PR', async () => {
        const repo = await seedRepo(await seedProject());
        await seedJob(repo, 'queued', { prNumber: 7, branch: 'claude/x', lastReason: 'CI failure' });
        await seedJob(repo, 'queued', { prNumber: 8, branch: 'claude/y' });
        await seedJob(repo);
        await repos.update({ id: repo.id }, { maxConcurrentJobs: 3 });
        await dispatcher.dispatch();
        const payloads = fire.mock.calls.map((c) => c[1] as Record<string, unknown>);
        expect(payloads[0]!.continueOn).toEqual({ branch: 'claude/x', prNumber: 7, reason: 'CI failure' });
        expect(payloads[1]!.continueOn).toEqual({ branch: 'claude/y', prNumber: 8, reason: 'Continue the work on this PR.' });
        expect(payloads[2]).not.toHaveProperty('continueOn');
    });

    it('adds the feature to the payload when the job has one, with the spec truncated, and omits it otherwise', async () => {
        const repo = await seedRepo(await seedProject());
        const feature = await ds.getRepository(Feature).save(ds.getRepository(Feature).create({
            projectId: repo.projectId, title: 'Big feature', spec: 'x'.repeat(9000), acceptanceCriteria: ['c1'], status: 'active',
        }));
        await seedJob(repo, 'queued', { featureId: feature.id });
        await seedJob(repo, 'queued', { featureId: null });
        await repos.update({ id: repo.id }, { maxConcurrentJobs: 2 });

        await dispatcher.dispatch();
        const payloads = fire.mock.calls.map((c) => c[1] as Record<string, unknown>);
        expect(payloads[0]!.feature).toEqual({ title: 'Big feature', spec: 'x'.repeat(8000), acceptanceCriteria: ['c1'] });
        expect(payloads[1]).not.toHaveProperty('feature');
    });

    it('never fires the same job twice with parallel dispatches', async () => {
        const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
        await seedJob(repo);
        await seedJob(repo);
        fire.mockImplementation(() => new Promise((r) => setTimeout(() => r({ sessionId: 's', sessionUrl: 'u' }), 10)));

        const other = new DispatcherService(new RunService(new RunMapper(), runs), fakeExecution(), jobs, repos, projects, runs, undefined as never, ds.getRepository(Feature), { searchLessons } as never, budget as never, budgetAlerts as never);
        const [a, b] = await Promise.all([dispatcher.dispatch(), other.dispatch()]);

        expect(a.fired + b.fired).toBe(2);
        expect(fire).toHaveBeenCalledTimes(2);
        const ids = (fire.mock.calls as [unknown, { jobId: string }][]).map((c) => c[1].jobId);
        expect(new Set(ids).size).toBe(2);
        expect(await runs.count()).toBe(2);
    });

    it('respects repo concurrency, counting active jobs, oldest first', async () => {
        const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 2 });
        await seedJob(repo, 'pr_open');
        const oldest = await seedJob(repo);
        const newer = await seedJob(repo);

        expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });

        expect((await reload(oldest.id)).status).toBe('dispatched');
        expect((await reload(newer.id)).status).toBe('queued');
    });

    it('respects the project daily limit across repos, counting earlier runs today', async () => {
        const project = await seedProject({ dailyRunLimit: 3 });
        const r1 = await seedRepo(project);
        const r2 = await seedRepo(project);
        const old = await seedJob(r1, 'merged');
        await runs.save(runs.create({ jobId: old.id, projectId: project.id, repoId: r1.id, attempt: 1, status: 'fired' }));
        // a run from before UTC midnight does not count
        await runs.save(runs.create({
            jobId: old.id, projectId: project.id, repoId: r1.id, attempt: 2, status: 'fired',
            createdAt: new Date(Date.now() - 48 * 3600_000),
        }));
        await seedJob(r1);
        await seedJob(r1);
        await seedJob(r2);
        await seedJob(r2);

        expect(await dispatcher.dispatch()).toMatchObject({ fired: 2, failed: 0 });
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 0 });
    });

    it.each([
        ['project paused', async () => { const p = await seedProject({ paused: true }); return seedRepo(p); }],
        ['repo paused', async () => seedRepo(await seedProject(), { paused: true })],
        ['no routine url', async () => seedRepo(await seedProject(), { routineFireUrl: null })],
        ['no routine token env', async () => seedRepo(await seedProject(), { routineTokenEnv: null })],
    ])('fires nothing when %s', async (_name, setup) => {
        const job = await seedJob(await setup());
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 0 });
        expect(fire).not.toHaveBeenCalled();
        expect((await reload(job.id)).status).toBe('queued');
    });

    it('requeues a retryable failure until maxAttempts, then parks', async () => {
        const repo = await seedRepo(await seedProject({ maxAttempts: 2 }));
        const job = await seedJob(repo);
        fire.mockRejectedValue(new ExecutionError('boom', 'transient'));

        await dispatcher.dispatch();
        expect(await reload(job.id)).toMatchObject({ status: 'queued', attempts: 1, lastReason: 'boom' });
        expect(await runs.findOneByOrFail({ jobId: job.id, attempt: 1 })).toMatchObject({ status: 'fire_failed', error: 'boom' });

        await dispatcher.dispatch();
        expect(await reload(job.id)).toMatchObject({ status: 'parked', attempts: 2, lastReason: 'boom' });
        expect(await runs.count()).toBe(2);
    });

    it('parks immediately on a invalid_response ExecutionError', async () => {
        const job = await seedJob(await seedRepo(await seedProject()));
        fire.mockRejectedValue(new ExecutionError('bad response', 'invalid_response'));

        await dispatcher.dispatch();

        expect(await reload(job.id)).toMatchObject({ status: 'parked', attempts: 1, lastReason: 'bad response' });
        expect(await runs.findOneByOrFail({ jobId: job.id })).toMatchObject({ status: 'fire_failed', error: 'bad response' });
    });

    it('parks immediately on an unknown error', async () => {
        const job = await seedJob(await seedRepo(await seedProject()));
        fire.mockRejectedValue(new Error('kaput'));

        await dispatcher.dispatch();

        expect(await reload(job.id)).toMatchObject({ status: 'parked', lastReason: 'kaput' });
    });

    describe('job.parked notifications', () => {
        it('records one event when a failed fire parks the job, keyed by job, attempt and cause', async () => {
            const repo = await seedRepo(await seedProject({ maxAttempts: 2 }));
            const job = await seedJob(repo);
            fire.mockRejectedValue(new ExecutionError('boom', 'transient'));

            await dispatcher.dispatch();
            expect(await notifications.count()).toBe(0); // requeued, not parked

            await dispatcher.dispatch();
            const rows = await notifications.find();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                kind: 'job.parked', jobId: job.id, projectId: repo.projectId, title: 'T', repos: [repo.fullName],
                reason: 'boom', prLinks: [], occurrenceKey: `job.parked:${job.id}:a2:none:dispatch`,
            });
        });

        it('records nothing for a config error, which requeues without parking', async () => {
            const repo = await seedRepo(await seedProject());
            await seedJob(repo);
            fire.mockRejectedValue(new ExecutionError('token missing', 'config'));
            await dispatcher.dispatch();
            expect(await notifications.count()).toBe(0);
        });

        it('records nothing when another writer moved the job first', async () => {
            const job = await seedJob(await seedRepo(await seedProject()));
            fire.mockImplementation(async () => {
                await jobs.update({ id: job.id }, { status: 'cancelled' });
                throw new Error('kaput');
            });
            await dispatcher.dispatch();
            expect((await reload(job.id)).status).toBe('cancelled');
            expect(await notifications.count()).toBe(0);
        });

        it('keeps the parked outcome when the insert fails', async () => {
            const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            vi.spyOn(notifications, 'insert').mockRejectedValue(new Error('insert down'));
            const job = await seedJob(await seedRepo(await seedProject()));
            fire.mockRejectedValue(new Error('kaput'));
            expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 1 });
            expect(await reload(job.id)).toMatchObject({ status: 'parked', lastReason: 'kaput', attempts: 1 });
            expect(log).toHaveBeenCalled();
            log.mockRestore();
        });
    });

    it('marks the run fire_failed on an unknown error', async () => {
        const job = await seedJob(await seedRepo(await seedProject()));
        fire.mockRejectedValue(new Error('kaput'));

        await dispatcher.dispatch();

        expect(await runs.findOneByOrFail({ jobId: job.id })).toMatchObject({ status: 'fire_failed', error: 'kaput' });
    });

    it('counts failed fires in failed, not fired', async () => {
        const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
        await seedJob(repo);
        await seedJob(repo);
        fire.mockResolvedValueOnce({ sessionId: 's', sessionUrl: 'u' }).mockRejectedValueOnce(new Error('kaput'));

        expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 1 });
    });

    it('returns immediately while a pass is running, and releases the guard after an error', async () => {
        const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
        await seedJob(repo);
        let release!: () => void;
        fire.mockImplementationOnce(() => new Promise((r) => { release = () => r({ sessionId: 's', sessionUrl: 'u' }); }));

        const first = dispatcher.dispatch();
        await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce());
        await seedJob(repo);
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 0 });
        expect(fire).toHaveBeenCalledOnce();
        release();
        expect(await first).toMatchObject({ fired: 1, failed: 0 });

        vi.spyOn(jobs, 'find').mockRejectedValueOnce(new Error('db down'));
        await expect(dispatcher.dispatch()).rejects.toThrow('db down');
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });
    });

    describe('configuration errors', () => {
        it('pauses the repo, requeues the job and leaves attempts unchanged on a 401', async () => {
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            const message = 'Routine fire for o/r failed with HTTP 401';
            fire.mockRejectedValue(new ExecutionError(message, 'config'));
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

            expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 1 });

            expect(await reload(job.id)).toMatchObject({ status: 'queued', attempts: 0, lastReason: message });
            expect(await repos.findOneByOrFail({ id: repo.id })).toMatchObject({ paused: true, pausedReason: message });
            expect(await runs.findOneByOrFail({ jobId: job.id })).toMatchObject({ status: 'fire_failed', error: message });
            expect(warn).toHaveBeenCalledOnce();
            expect(warn.mock.calls[0]![0]).toContain(repo.fullName);
            expect(warn.mock.calls[0]![0]).toContain(message);
        });

        it('does not fire other queued jobs of the paused repo', async () => {
            const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
            const first = await seedJob(repo);
            const second = await seedJob(repo);
            fire.mockRejectedValueOnce(new ExecutionError('HTTP 401', 'config'));

            await dispatcher.dispatch();
            await dispatcher.dispatch();

            expect(fire).toHaveBeenCalledOnce();
            expect((await reload(first.id)).status).toBe('queued');
            expect((await reload(second.id)).status).toBe('queued');
        });

        it('fires the queued job after the repo is resumed, clearing pausedReason', async () => {
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            fire.mockRejectedValueOnce(new ExecutionError('HTTP 401', 'config'));
            await dispatcher.dispatch();

            const resumed = await repoService.resume(repo.id);
            expect(resumed).toMatchObject({ paused: false });

            expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });
            expect(await reload(job.id)).toMatchObject({ status: 'dispatched', attempts: 1 });
        });

        it('does not pause the repo on transient errors', async () => {
            const repo = await seedRepo(await seedProject());
            await seedJob(repo);
            fire.mockRejectedValue(new ExecutionError('later', 'transient'));

            await dispatcher.dispatch();

            expect(await repos.findOneByOrFail({ id: repo.id })).toMatchObject({ paused: false });
        });
    });
});

describe('DispatcherService report', () => {
    const only = async () => (await dispatcher.dispatch()).repos[0]!;

    it('reports a paused repo with its reason', async () => {
        const repo = await seedRepo(await seedProject(), { paused: true, pausedReason: 'token expired' });
        await seedJob(repo);
        expect(await only()).toMatchObject({ reason: 'repo_paused', detail: 'token expired', queued: 1, fired: 0 });
    });

    it('reports a paused project', async () => {
        await seedJob(await seedRepo(await seedProject({ paused: true })));
        expect(await only()).toMatchObject({ reason: 'project_paused' });
    });

    it('reports a missing routine', async () => {
        await seedJob(await seedRepo(await seedProject(), { routineFireUrl: null, routineTokenEnv: null }));
        expect(await only()).toMatchObject({ reason: 'no_routine' });
    });

    it('reports no free slots with active/max', async () => {
        const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 1 });
        await seedJob(repo, 'dispatched');
        await seedJob(repo);
        expect(await only()).toMatchObject({ reason: 'no_slots', detail: '1/1' });
    });

    it('reports the daily limit with the next UTC midnight', async () => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-04T10:00:00Z') });
        try {
            const project = await seedProject({ dailyRunLimit: 1 });
            const repo = await seedRepo(project);
            await seedJob(repo);
            await seedJob(repo);
            expect((await only())).toMatchObject({ reason: 'none', fired: 1 });
            expect(await only()).toMatchObject({ reason: 'daily_limit', detail: '1/1', resetsAt: '2026-03-05T00:00:00.000Z' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports none, and counts jobs held by dependencies and proposals', async () => {
        const repo = await seedRepo(await seedProject());
        const blocker = await seedJob(repo, 'pr_open');
        const dependent = await seedJob(repo);
        await ds.getRepository(JobDependency).save({ jobId: dependent.id, dependsOnJobId: blocker.id });
        const revised = await seedJob(repo);
        await ds.getRepository(JobRevision).save(ds.getRepository(JobRevision).create({
            jobId: revised.id, status: 'proposed', reason: 'r',
        } as never));
        await seedJob(repo);
        expect(await only()).toMatchObject({
            reason: 'none', queued: 3, fired: 1, waitingOnDependencies: 1, waitingOnRevisions: 1,
        });
    });

    it('serves the last pass from status() without running one', async () => {
        expect(dispatcher.status()).toEqual({ at: null, result: null });
        await seedJob(await seedRepo(await seedProject()));
        await dispatcher.dispatch();
        const status = dispatcher.status();
        expect(status.at).toEqual(expect.any(String));
        expect(status.result).toMatchObject({ fired: 1 });
        expect(fire).toHaveBeenCalledTimes(1);
        dispatcher.status();
        expect(fire).toHaveBeenCalledTimes(1);
    });

    it('logs a repo line once per change, not every pass', async () => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        try {
            const repo = await seedRepo(await seedProject(), { paused: true, pausedReason: 'token expired' });
            await seedJob(repo);
            await dispatcher.dispatch();
            await dispatcher.dispatch();
            const lines = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`${repo.fullName}:`));
            expect(lines().filter((l) => l.includes('repo paused: token expired'))).toHaveLength(1);

            await repos.update({ id: repo.id }, { paused: false, pausedReason: null });
            await dispatcher.dispatch();
            expect(lines().some((l) => l.endsWith(': dispatching again'))).toBe(true);
        } finally {
            log.mockRestore();
        }
    });

    it('logs the daily limit once, in UTC', async () => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        try {
            const project = await seedProject({ dailyRunLimit: 0 });
            await seedJob(await seedRepo(project));
            await dispatcher.dispatch();
            await dispatcher.dispatch();
            const limited = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('daily limit reached') && l.includes('(0/0'));
            expect(limited).toHaveLength(1);
            expect(limited[0]).toMatch(/\(0\/0, resets \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\)/);
        } finally {
            log.mockRestore();
        }
    });

    describe('lessons', () => {
        const lessonHit = { lessonId: 'les1', projectId: '', targetRepoId: null, status: 'approved', score: 0.9, text: 'Stream large exports' };
        const sentPayload = () => (fire.mock.calls[0] as [unknown, { lessons?: unknown[] }])[1];

        it('adds relevant approved lessons, queried with title, task, criteria and stacks and scoped to project and repo', async () => {
            const project = await seedProject();
            const repo = await seedRepo(project, { stacks: ['nestjs'] });
            searchLessons.mockResolvedValue({ status: 'ok', lessons: [{ ...lessonHit, projectId: project.id }] });
            await seedJob(repo, 'queued', { title: 'Export invoices', task: 'stream them', acceptanceCriteria: ['no buffering'] });

            expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });
            expect(searchLessons).toHaveBeenCalledOnce();
            const arg = searchLessons.mock.calls[0]![0] as { projectId: string; repoId: string; query: string };
            expect(arg).toMatchObject({ projectId: project.id, repoId: repo.id });
            for (const part of ['Export invoices', 'stream them', 'no buffering', 'nestjs']) expect(arg.query).toContain(part);
            expect(sentPayload().lessons).toEqual([{ id: 'les1', text: 'Stream large exports', scope: 'project', status: 'approved', relevance: 0.9 }]);
        });

        it('leaves out lessons of another project or repo and revoked ones', async () => {
            const project = await seedProject();
            const repo = await seedRepo(project);
            searchLessons.mockResolvedValue({ status: 'ok', lessons: [
                { ...lessonHit, lessonId: 'foreign', projectId: 'other-project' },
                { ...lessonHit, lessonId: 'other-repo', projectId: project.id, targetRepoId: 'other-repo' },
                { ...lessonHit, lessonId: 'revoked', projectId: project.id, status: 'rejected' },
            ] });
            await seedJob(repo);
            await dispatcher.dispatch();
            expect(sentPayload()).not.toHaveProperty('lessons');
        });

        it.each([
            ['unavailable', () => searchLessons.mockResolvedValue({ status: 'unavailable', reason: 'no key', lessons: [] })],
            ['empty', () => searchLessons.mockResolvedValue({ status: 'ok', lessons: [] })],
            ['a 429', () => searchLessons.mockRejectedValue(new Error('429 rate limit'))],
            ['a vector error', () => searchLessons.mockRejectedValue(new Error('pgvector down'))],
            ['a hang', () => { vi.stubEnv('DISPATCH_LESSONS_TIMEOUT_MS', '100'); searchLessons.mockReturnValue(new Promise(() => undefined)); }],
        ])('still fires with no lessons, one attempt and no pause on %s', async (_name, arrange) => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            try {
                arrange();
                const repo = await seedRepo(await seedProject());
                const job = await seedJob(repo);
                expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });
                expect(sentPayload()).not.toHaveProperty('lessons');
                const after = await reload(job.id);
                expect(after).toMatchObject({ status: 'dispatched', attempts: 1 });
                expect(await runs.count()).toBe(1);
                expect(await runs.count({ where: { status: 'fire_failed' } })).toBe(0);
                expect((await repos.findOneByOrFail({ id: repo.id })).paused).toBe(false);
            } finally {
                vi.unstubAllEnvs();
                vi.restoreAllMocks();
            }
        });

        it('does not search for jobs that policy keeps from firing (paused, dependencies, limits)', async () => {
            const paused = await seedRepo(await seedProject(), { paused: true });
            await seedJob(paused);
            const limited = await seedRepo(await seedProject({ dailyRunLimit: 0 }));
            await seedJob(limited);
            const blocked = await seedRepo(await seedProject());
            const dep = await seedJob(blocked, 'pr_open');
            const waiting = await seedJob(blocked);
            await ds.getRepository(JobDependency).save({ jobId: waiting.id, dependsOnJobId: dep.id });

            expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 0 });
            expect(searchLessons).not.toHaveBeenCalled();
        });

        it('keeps a config error behaviour: attempt given back and repo paused, lessons or not', async () => {
            searchLessons.mockResolvedValue({ status: 'ok', lessons: [] });
            fire.mockRejectedValue(new ExecutionError('bad token', 'config'));
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 1 });
            expect(await reload(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
            expect((await repos.findOneByOrFail({ id: repo.id })).paused).toBe(true);
        });

        it('adds lessons when continuing a PR and keeps continuation context', async () => {
            const project = await seedProject();
            const repo = await seedRepo(project);
            searchLessons.mockResolvedValue({ status: 'ok', lessons: [{ ...lessonHit, projectId: project.id }] });
            await seedJob(repo, 'queued', { prNumber: 9, branch: 'claude/x', lastReason: 'CI failed' });
            await dispatcher.dispatch();
            expect(sentPayload()).toMatchObject({ continueOn: { branch: 'claude/x', prNumber: 9, reason: 'CI failed' }, lessons: [{ id: 'les1' }] });
        });
    });

    describe('estimated budget guard', () => {
        const blocker = (over: Record<string, unknown> = {}) => ({
            scope: 'project', projectId: 'p', period: 'day', kind: 'limit', variable: null, limit: 10, spent: 10,
            startsAt: '2026-01-01T00:00:00.000Z', resetsAt: '2026-01-02T00:00:00.000Z', message: 'reached', ...over,
        });
        const hard = (blockers: Record<string, unknown>[], recovery = 'reset', recoversAt: string | null = '2026-01-02T00:00:00.000Z') =>
            ({ hardBlocked: true, blockers, recovery, recoversAt });
        const clear = { hardBlocked: false, blockers: [], recovery: 'none', recoversAt: null };

        it.each([
            ['project day', [blocker()]],
            ['project week', [blocker({ period: 'week', resetsAt: '2026-01-05T00:00:00.000Z' })]],
            ['global day', [blocker({ scope: 'global', projectId: null })]],
            ['global week', [blocker({ scope: 'global', projectId: null, period: 'week' })]],
        ])('fires nothing at a hard %s limit: no run, attempt, transition, execution call or pause change', async (_name, blockers) => {
            budget.status.mockResolvedValue(hard(blockers));
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            const result = await dispatcher.dispatch();
            expect(result).toMatchObject({ fired: 0, failed: 0 });
            expect(fire).not.toHaveBeenCalled();
            expect(await runs.count()).toBe(0);
            expect(await reload(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
            expect(await projects.findOneByOrFail({ id: repo.projectId })).toMatchObject({ paused: false });
            expect(await repos.findOneByOrFail({ id: repo.id })).toMatchObject({ paused: false });
            expect(result.repos[0]).toMatchObject({ reason: 'budget', budget: { blockers, recovery: 'reset', error: false } });
            expect(budgetAlerts.capture).toHaveBeenCalled();
        });

        it('reports every simultaneous blocker and promises recovery only at the latest reset', async () => {
            const blockers = [blocker(), blocker({ period: 'week', resetsAt: '2026-01-05T00:00:00.000Z' })];
            budget.status.mockResolvedValue(hard(blockers, 'reset', '2026-01-05T00:00:00.000Z'));
            const repo = await seedRepo(await seedProject());
            await seedJob(repo);
            const [report] = (await dispatcher.dispatch()).repos;
            expect(report.resetsAt).toBe('2026-01-05T00:00:00.000Z');
            expect(report.detail).toContain('project day');
            expect(report.detail).toContain('project week');
        });

        it('has no reset promise when a limit or configuration change is needed', async () => {
            budget.status.mockResolvedValue(hard([blocker({ scope: 'global', projectId: null, kind: 'configError', variable: 'GLOBAL_DAILY_BUDGET_USD', limit: null })], 'manual', null));
            const repo = await seedRepo(await seedProject());
            await seedJob(repo);
            const [report] = (await dispatcher.dispatch()).repos;
            expect(report).toMatchObject({ reason: 'budget', resetsAt: null, budget: { recovery: 'manual' } });
            expect(report.detail).toContain('GLOBAL_DAILY_BUDGET_USD');
            expect(report.detail).not.toMatch(/\d{4}-\d\d-\d\dT/);
        });

        it('stops mid-pass when a hard limit is reached by the previous fire', async () => {
            budget.status.mockResolvedValueOnce(clear).mockResolvedValue(hard([blocker()]));
            const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
            const first = await seedJob(repo);
            const second = await seedJob(repo);
            const result = await dispatcher.dispatch();
            expect(result.fired).toBe(1);
            expect(fire).toHaveBeenCalledTimes(1);
            expect((await reload(first.id)).status).toBe('dispatched');
            expect(await reload(second.id)).toMatchObject({ status: 'queued', attempts: 0 });
            expect(result.repos[0]).toMatchObject({ fired: 1, reason: 'budget' });
        });

        it('checks live spend for every repo of a project in the same pass', async () => {
            budget.status.mockResolvedValueOnce(clear).mockResolvedValue(hard([blocker()]));
            const project = await seedProject();
            await seedJob(await seedRepo(project));
            await seedJob(await seedRepo(project));
            const result = await dispatcher.dispatch();
            expect(result.fired).toBe(1);
            expect(result.repos.map((r) => r.reason).sort()).toEqual(['budget', 'none']);
        });

        it('keeps manual pause precedence: a paused project and repo report their own reason and stay paused after recovery', async () => {
            budget.status.mockResolvedValue(hard([blocker()]));
            const project = await seedProject({ paused: true });
            const repo = await seedRepo(project);
            await seedJob(repo);
            expect((await dispatcher.dispatch()).repos[0].reason).toBe('project_paused');
            budget.status.mockResolvedValue(clear);
            expect((await dispatcher.dispatch()).fired).toBe(0);
            expect(await projects.findOneByOrFail({ id: project.id })).toMatchObject({ paused: true });
        });

        it('still reports daily run limit, no slots and missing manifest ahead of the budget', async () => {
            budget.status.mockResolvedValue(hard([blocker()]));
            const limited = await seedRepo(await seedProject({ dailyRunLimit: 0 }));
            await seedJob(limited);
            const busy = await seedRepo(await seedProject(), { maxConcurrentJobs: 1 });
            await seedJob(busy, 'pr_open');
            await seedJob(busy);
            const bare = await seedRepo(await seedProject(), { testCommands: [] });
            await seedJob(bare);
            const reasons = Object.fromEntries((await dispatcher.dispatch()).repos.map((r) => [r.repoId, r.reason]));
            expect(reasons).toEqual({ [limited.id]: 'daily_limit', [busy.id]: 'no_slots', [bare.id]: 'no_manifest' });
        });

        it('resumes automatically after a reset, a raised limit or a cleared limit, without a pause toggle', async () => {
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            budget.status.mockResolvedValue(hard([blocker()]));
            expect((await dispatcher.dispatch()).fired).toBe(0);
            budget.status.mockResolvedValue(clear);
            expect((await dispatcher.dispatch()).fired).toBe(1);
            expect((await reload(job.id)).status).toBe('dispatched');
        });

        it('fails closed when the budget cannot be evaluated, honestly and without fabricating a status', async () => {
            const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            budget.status.mockRejectedValue(new Error('usage db down'));
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            const result = await dispatcher.dispatch();
            expect(result.fired).toBe(0);
            expect(fire).not.toHaveBeenCalled();
            expect(await reload(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
            expect(result.repos[0]).toMatchObject({ reason: 'budget', resetsAt: null, budget: { blockers: [], error: true, recovery: 'unknown' } });
            expect(error).toHaveBeenCalledWith(expect.stringContaining('usage db down'));
            error.mockRestore();
        });

        it('does not touch running work, and queued jobs that are not new fires are unaffected', async () => {
            budget.status.mockResolvedValue(hard([blocker()]));
            const repo = await seedRepo(await seedProject());
            const running = await seedJob(repo, 'dispatched');
            await dispatcher.dispatch();
            expect((await reload(running.id)).status).toBe('dispatched');
        });

        it('does not stop a pass when recording the notification fails', async () => {
            budget.status.mockResolvedValue(hard([blocker()]));
            budgetAlerts.capture.mockRejectedValue(new Error('outbox down'));
            const repo = await seedRepo(await seedProject());
            await seedJob(repo);
            const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            const result = await dispatcher.dispatch();
            expect(result.repos[0].reason).toBe('budget');
            expect(fire).not.toHaveBeenCalled();
            error.mockRestore();
        });

        it('applies to the authenticated manual dispatch path too: there is no bypass', async () => {
            budget.status.mockResolvedValue(hard([blocker()]));
            const repo = await seedRepo(await seedProject());
            await seedJob(repo);
            const result = await new DispatchController(dispatcher).dispatch();
            expect(result).toMatchObject({ fired: 0, repos: [{ reason: 'budget' }] });
            expect(fire).not.toHaveBeenCalled();
        });
    });
    describe('prompts that cannot fit', () => {
        const huge = 'T'.repeat(61_000);

        it('parks only that job, creates no run and spends no attempt, then fires the next job of the same repo', async () => {
            const repo = await seedRepo(await seedProject({ dailyRunLimit: 1 }), { maxConcurrentJobs: 1 });
            const big = await seedJob(repo, 'queued', { task: huge });
            const next = await seedJob(repo);

            const result = await dispatcher.dispatch();

            expect(result).toMatchObject({ fired: 1, failed: 0 });
            const parked = await reload(big.id);
            expect(parked.status).toBe('parked');
            expect(parked.attempts).toBe(0);
            expect(parked.lastReason).toMatch(/^Prompt for job .* is 6\d \d{3} characters after trimming, over the 60 000 limit; the task and criteria alone are 61 001: shorten the task/);
            expect(await runs.count({ where: { jobId: big.id } })).toBe(0);
            expect(fire).toHaveBeenCalledTimes(1);
            expect((fire.mock.calls[0][1] as { jobId: string }).jobId).toBe(next.id);
            expect((await reload(next.id)).status).toBe('dispatched');
            expect((await repos.findOneByOrFail({ id: repo.id })).paused).toBe(false);
            expect(await runs.count()).toBe(1);
        });

        it('uses neither the daily allowance nor a slot when nothing else can fire', async () => {
            const repo = await seedRepo(await seedProject({ dailyRunLimit: 1 }), { maxConcurrentJobs: 1 });
            const big = await seedJob(repo, 'queued', { task: huge });
            const result = await dispatcher.dispatch();
            expect(result).toMatchObject({ fired: 0, failed: 0 });
            expect(fire).not.toHaveBeenCalled();
            expect(await runs.count()).toBe(0);
            expect((await reload(big.id)).status).toBe('parked');
            // The slot and the allowance are still free for the next job.
            const later = await seedJob(repo);
            expect(await dispatcher.dispatch()).toMatchObject({ fired: 1 });
            expect((await reload(later.id)).status).toBe('dispatched');
        });

        it('sizes the prompt with the id of the run that is created, and keeps the reserved id of an earlier failed run', async () => {
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            await dispatcher.dispatch();
            const run = await runs.findOneByOrFail({ jobId: job.id });
            expect((fire.mock.calls[0][1] as { runId: string }).runId).toBe(run.id);
        });

        it('a repo configuration error from preparing still pauses the repo and gives the attempt back', async () => {
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            prepareFailure = new ExecutionError('Agent instructions file /x is missing or unreadable', 'config');
            // Counted as a failed fire attempt, like any other repo configuration error.
            expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 1 });
            const after = await repos.findOneByOrFail({ id: repo.id });
            expect(after.paused).toBe(true);
            expect(after.pausedReason).toContain('missing or unreadable');
            expect(await reload(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
            expect(await runs.count()).toBe(0);
        });

        it('leaves an already paused repo paused and its queued oversized job untouched', async () => {
            const repo = await seedRepo(await seedProject(), { paused: true, pausedReason: 'bad token' });
            const big = await seedJob(repo, 'queued', { task: huge });
            await dispatcher.dispatch();
            expect((await repos.findOneByOrFail({ id: repo.id })).paused).toBe(true);
            expect((await reload(big.id)).status).toBe('queued');
        });

        it('two concurrent dispatchers park the job once and fire nothing', async () => {
            const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
            const big = await seedJob(repo, 'queued', { task: huge });
            const other = new DispatcherService(new RunService(new RunMapper(), runs), fakeExecution(), jobs, repos, projects, runs, undefined as never, ds.getRepository(Feature), { searchLessons } as never, budget as never, budgetAlerts as never);
            await Promise.all([dispatcher.dispatch(), other.dispatch()]);
            expect(await reload(big.id)).toMatchObject({ status: 'parked', attempts: 0 });
            expect(fire).not.toHaveBeenCalled();
            expect(await runs.count()).toBe(0);
        });

        it('an oversize caused by the instructions parks the job and never sends the text', async () => {
            instructionsText = 'I'.repeat(60_000);
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            await dispatcher.dispatch();
            const parked = await reload(job.id);
            expect(parked.status).toBe('parked');
            expect(parked.lastReason).toContain('the agent instructions take 60 000');
            expect(fire).not.toHaveBeenCalled();
        });
    });
});
