import { Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionError } from '../execution/execution.error.js';
import { User } from '../user/user.entity.js';
import { Feature } from '../feature/feature.entity.js';
import type { ExecutionPort } from '../execution/execution.port.js';
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
import { DispatcherService } from './dispatcher.service.js';

let ds: DataSource;
let fire: ReturnType<typeof vi.fn>;
let dispatcher: DispatcherService;
let projects: Repository<Project>;
let repos: Repository<Repo>;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let repoService: RepoService;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [User, Project, Repo, Job, JobRun, JobDependency, Feature, JobRevision],
        synchronize: true,
    }).initialize();
    projects = ds.getRepository(Project);
    repos = ds.getRepository(Repo);
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    fire = vi.fn().mockResolvedValue({ sessionId: 's1', sessionUrl: 'https://x/s1' });
    const execution: ExecutionPort = { fire: (r, p) => fire(r, p) as ReturnType<ExecutionPort['fire']>, preview: () => ({ text: '', instructionsVersion: null }) };
    repoService = new RepoService(new RepoMapper(), {} as never, repos);
    dispatcher = new DispatcherService(new RunService(new RunMapper(), runs), execution, jobs, repos, projects, runs, repoService, ds.getRepository(Feature));
});

afterEach(() => ds.destroy());

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

        const other = new DispatcherService(new RunService(new RunMapper(), runs), { fire: (r, p) => fire(r, p) as ReturnType<ExecutionPort['fire']>, preview: () => ({ text: '', instructionsVersion: null }) }, jobs, repos, projects, runs, undefined as never, ds.getRepository(Feature));
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
            expect(resumed).toMatchObject({ paused: false, pausedReason: null });

            expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });
            expect(await reload(job.id)).toMatchObject({ status: 'dispatched', attempts: 1 });
        });

        it('does not pause the repo on transient errors', async () => {
            const repo = await seedRepo(await seedProject());
            await seedJob(repo);
            fire.mockRejectedValue(new ExecutionError('later', 'transient'));

            await dispatcher.dispatch();

            expect(await repos.findOneByOrFail({ id: repo.id })).toMatchObject({ paused: false, pausedReason: null });
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
});
