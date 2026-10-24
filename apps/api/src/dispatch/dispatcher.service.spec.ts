import { Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionError } from '../execution/execution.error.js';
import type { ExecutionPort } from '../execution/execution.port.js';
import type { JobStatus } from '../job/job-state.js';
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
        entities: [Project, Repo, Job, JobRun],
        synchronize: true,
    }).initialize();
    projects = ds.getRepository(Project);
    repos = ds.getRepository(Repo);
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    fire = vi.fn().mockResolvedValue({ sessionId: 's1', sessionUrl: 'https://x/s1' });
    const execution: ExecutionPort = { fire: (r, p) => fire(r, p) as ReturnType<ExecutionPort['fire']> };
    repoService = new RepoService(new RepoMapper(), {} as never, repos);
    dispatcher = new DispatcherService(new RunService(new RunMapper(), runs), execution, jobs, repos, projects, runs, repoService);
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

    it('never fires the same job twice with parallel dispatches', async () => {
        const repo = await seedRepo(await seedProject(), { maxConcurrentJobs: 5 });
        await seedJob(repo);
        await seedJob(repo);
        fire.mockImplementation(() => new Promise((r) => setTimeout(() => r({ sessionId: 's', sessionUrl: 'u' }), 10)));

        const other = new DispatcherService(new RunService(new RunMapper(), runs), { fire: (r, p) => fire(r, p) as ReturnType<ExecutionPort['fire']> }, jobs, repos, projects, runs);
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
