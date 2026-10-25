import { Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionError } from '../execution/execution.error.js';
import { Feature } from '../feature/feature.entity.js';
import type { ExecutionPort } from '../execution/execution.port.js';
import type { JobStatus } from '../job/job-state.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
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
        entities: [Project, Repo, Job, JobRun, JobDependency, Feature],
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
        testCommand: 'pnpm test',
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
    it('never fires triage jobs', async () => {
        const repo = await seedRepo(await seedProject());
        const triage = await seedJob(repo, 'triage', { queuedAt: null });
        expect(await dispatcher.dispatch()).toEqual({ fired: 0, failed: 0 });
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

            expect(await dispatcher.dispatch()).toEqual({ fired: 0, failed: 0 });
            expect(fire).not.toHaveBeenCalled();

            await jobs.update({ id: dep.id }, { status: 'merged' });
            expect(await dispatcher.dispatch()).toEqual({ fired: 1, failed: 0 });
            expect((await reload(job.id)).status).toBe('dispatched');
        });

        it('lets a newer unblocked job fire past an older blocked one, and logs the waiting count', async () => {
            const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 1 });
            const dep = await seedJob(repo, 'pr_open', { queuedAt: new Date(Date.UTC(2025, 0, 1)) });
            const blocked = await seedJob(repo);
            const free = await seedJob(repo);
            await link(blocked, dep);
            // dep is pr_open (active) but repo has 2 slots worth of room only if we raise it
            await repos.update({ id: repo.id }, { maxConcurrentJobs: 2 });
            const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

            expect(await dispatcher.dispatch()).toEqual({ fired: 1, failed: 0 });
            expect((await reload(free.id)).status).toBe('dispatched');
            expect((await reload(blocked.id)).status).toBe('queued');
            expect(log).toHaveBeenCalledWith(`${repo.fullName}: 1 queued job(s) waiting on dependencies`);
        });
    });

    it('fires a queued job with the full payload and records the run', async () => {
        const repo = await seedRepo(await seedProject());
        const job = await seedJob(repo);

        expect(await dispatcher.dispatch()).toEqual({ fired: 1, failed: 0 });

        expect(fire).toHaveBeenCalledOnce();
        const [execRepo, payload] = fire.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(execRepo).toMatchObject({ fullName: repo.fullName, routineFireUrl: 'https://fire' });
        const run = await runs.findOneByOrFail({ jobId: job.id });
        expect(payload).toEqual({
            gilde: 1, jobId: job.id, runId: run.id, attempt: 1, repo: repo.fullName, baseBranch: 'main',
            title: 'T', task: 'do', acceptanceCriteria: ['a'], testCommand: 'pnpm test',
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

        expect(await dispatcher.dispatch()).toEqual({ fired: 1, failed: 0 });

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

        expect(await dispatcher.dispatch()).toEqual({ fired: 2, failed: 0 });
        expect(await dispatcher.dispatch()).toEqual({ fired: 0, failed: 0 });
    });

    it.each([
        ['project paused', async () => { const p = await seedProject({ paused: true }); return seedRepo(p); }],
        ['repo paused', async () => seedRepo(await seedProject(), { paused: true })],
        ['no routine url', async () => seedRepo(await seedProject(), { routineFireUrl: null })],
        ['no routine token env', async () => seedRepo(await seedProject(), { routineTokenEnv: null })],
    ])('fires nothing when %s', async (_name, setup) => {
        const job = await seedJob(await setup());
        expect(await dispatcher.dispatch()).toEqual({ fired: 0, failed: 0 });
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

        expect(await dispatcher.dispatch()).toEqual({ fired: 1, failed: 1 });
    });

    it('returns immediately while a pass is running, and releases the guard after an error', async () => {
        const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
        await seedJob(repo);
        let release!: () => void;
        fire.mockImplementationOnce(() => new Promise((r) => { release = () => r({ sessionId: 's', sessionUrl: 'u' }); }));

        const first = dispatcher.dispatch();
        await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce());
        await seedJob(repo);
        expect(await dispatcher.dispatch()).toEqual({ fired: 0, failed: 0 });
        expect(fire).toHaveBeenCalledOnce();
        release();
        expect(await first).toEqual({ fired: 1, failed: 0 });

        vi.spyOn(jobs, 'find').mockRejectedValueOnce(new Error('db down'));
        await expect(dispatcher.dispatch()).rejects.toThrow('db down');
        expect(await dispatcher.dispatch()).toEqual({ fired: 1, failed: 0 });
    });

    describe('configuration errors', () => {
        it('pauses the repo, requeues the job and leaves attempts unchanged on a 401', async () => {
            const repo = await seedRepo(await seedProject());
            const job = await seedJob(repo);
            const message = 'Routine fire for o/r failed with HTTP 401';
            fire.mockRejectedValue(new ExecutionError(message, 'config'));
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

            expect(await dispatcher.dispatch()).toEqual({ fired: 0, failed: 1 });

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

            expect(await dispatcher.dispatch()).toEqual({ fired: 1, failed: 0 });
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
