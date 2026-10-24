import { NotFoundException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JOB_STATUSES, type JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import type { ProjectService } from '../project/project.service.js';
import { Repo } from '../repo/repo.entity.js';
import type { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { MetricsService } from './metrics.service.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

let ds: DataSource;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let service: MetricsService;
let repo: Repo;
let otherRepo: Repo;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [Project, Repo, Job, JobRun], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    const projects = ds.getRepository(Project);
    const repos = ds.getRepository(Repo);
    const project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
    const other = await projects.save(projects.create({ slug: 'q', name: 'Q' }));
    repo = await repos.save(repos.create({ projectId: project.id, fullName: 'o/a', testCommand: 't' }));
    otherRepo = await repos.save(repos.create({ projectId: other.id, fullName: 'o/b', testCommand: 't' }));
    const projectService = {
        assertExists: async (id: string) => { if (!(await projects.existsBy({ id }))) throw new NotFoundException(); },
    } as unknown as ProjectService;
    const repoService = {
        getById: async (id: string) => { if (!(await repos.existsBy({ id }))) throw new NotFoundException(); },
    } as unknown as RepoService;
    service = new MetricsService(projectService, repoService, jobs, runs);
});

afterEach(() => ds.destroy());

async function seedJob(status: JobStatus, createdAt: string, over: Partial<Job> = {}, r: Repo = repo) {
    const job = await jobs.save(jobs.create({
        projectId: r.projectId, repoId: r.id, title: 'T', task: 'do', status, queuedAt: new Date(), attempts: 1, ...over,
    }));
    await jobs.update({ id: job.id }, { createdAt: new Date(createdAt), updatedAt: new Date(createdAt) });
    return job;
}

async function seedRun(job: Job, attempt: number, over: Partial<JobRun> = {}) {
    return runs.save(runs.create({
        jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt, status: 'fired', ...over,
    }));
}

describe('MetricsService', () => {
    it('returns zeros, nulls and a full zero-filled daily series for an empty database', async () => {
        const m = await service.get({ days: 7 }, NOW);
        expect(m.jobs.total).toBe(0);
        expect(Object.keys(m.jobs.countByStatus)).toEqual([...JOB_STATUSES]);
        expect(Object.values(m.jobs.countByStatus).every((n) => n === 0)).toBe(true);
        expect(m).toMatchObject({
            mergeRate: null, firstPassRate: null, avgAttempts: null, timeToMerge: { median: null, p90: null },
            runs: { total: 0, byOutcome: { done: 0, partial: 0, blocked: 0, none: 0 }, byCiConclusion: { none: 0 }, gateFailures: 0 },
        });
        expect(m.daily.map((d) => d.date)).toEqual([
            '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10',
        ]);
        expect(m.daily.every((d) => d.created === 0 && d.merged === 0 && d.parked === 0)).toBe(true);
    });

    it('computes rates, attempts and counts', async () => {
        await seedJob('merged', '2026-03-09T10:00:00Z', { attempts: 1 });
        await seedJob('merged', '2026-03-09T10:00:00Z', { attempts: 3 });
        await seedJob('rejected', '2026-03-09T10:00:00Z', { attempts: 2 });
        await seedJob('parked', '2026-03-09T10:00:00Z', { attempts: 2 });
        await seedJob('queued', '2026-03-09T10:00:00Z', { attempts: 0, needsApproval: true });
        await seedJob('cancelled', '2026-03-09T10:00:00Z');

        const m = await service.get({ days: 30 }, NOW);
        expect(m.jobs.total).toBe(6);
        expect(m.jobs.countByStatus).toMatchObject({ merged: 2, rejected: 1, parked: 1, queued: 1, cancelled: 1, dispatched: 0 });
        expect(m.mergeRate).toBe(0.5);
        expect(m.firstPassRate).toBe(0.5);
        expect(m.avgAttempts).toBe(2);
        expect(m.runs.gateFailures).toBe(1);
    });

    it('returns null rates when the denominators are empty', async () => {
        await seedJob('queued', '2026-03-09T10:00:00Z');
        await seedJob('cancelled', '2026-03-09T10:00:00Z');
        const m = await service.get({ days: 30 }, NOW);
        expect(m.mergeRate).toBeNull();
        expect(m.firstPassRate).toBeNull();
        expect(m.avgAttempts).toBeNull();
        expect(m.timeToMerge).toEqual({ median: null, p90: null });
    });

    it('measures time to merge from job creation to the last run finishing', async () => {
        // 10, 20, 30, 40 minutes; the first job has an earlier run that must be ignored.
        for (const [i, mins] of [10, 20, 30, 40].entries()) {
            const job = await seedJob('merged', '2026-03-09T10:00:00Z');
            if (i === 0) await seedRun(job, 1, { finishedAt: new Date('2026-03-09T10:01:00Z') });
            await seedRun(job, i === 0 ? 2 : 1, { finishedAt: new Date(Date.parse('2026-03-09T10:00:00Z') + mins * 60_000) });
        }
        // Merged but its run never finished: not part of the sample.
        const unfinished = await seedJob('merged', '2026-03-09T10:00:00Z');
        await seedRun(unfinished, 1);

        const m = await service.get({ days: 30 }, NOW);
        expect(m.timeToMerge).toEqual({ median: 25, p90: 40 });
    });

    it('breaks runs down by outcome and CI conclusion', async () => {
        const job = await seedJob('merged', '2026-03-09T10:00:00Z');
        const result = (outcome: 'done' | 'partial' | 'blocked') => ({ outcome, summary: 's' });
        await seedRun(job, 1, { result: result('partial'), ciConclusion: 'failure' });
        await seedRun(job, 2, { result: result('done'), ciConclusion: 'success' });
        await seedRun(job, 3, { result: result('blocked') });
        await seedRun(job, 4, { ciConclusion: 'success' });

        const m = await service.get({ days: 30 }, NOW);
        expect(m.runs.total).toBe(4);
        expect(m.runs.byOutcome).toEqual({ done: 1, partial: 1, blocked: 1, none: 1 });
        expect(m.runs.byCiConclusion).toEqual({ failure: 1, success: 2, none: 1 });
    });

    it('fills empty days with zeros and buckets created/merged/parked by UTC day', async () => {
        const merged = await seedJob('merged', '2026-03-08T23:30:00Z');
        await seedRun(merged, 1, { finishedAt: new Date('2026-03-09T00:30:00Z') });
        await seedJob('parked', '2026-03-10T01:00:00Z');

        const m = await service.get({ days: 4 }, NOW);
        expect(m.daily).toEqual([
            { date: '2026-03-07', created: 0, merged: 0, parked: 0 },
            { date: '2026-03-08', created: 1, merged: 0, parked: 0 },
            { date: '2026-03-09', created: 0, merged: 1, parked: 0 },
            { date: '2026-03-10', created: 1, merged: 0, parked: 1 },
        ]);
    });

    describe('filters', () => {
        it('limits jobs to the day window on created_at', async () => {
            await seedJob('queued', '2026-03-10T00:00:00Z');
            await seedJob('queued', '2026-03-04T00:00:00Z');
            await seedJob('queued', '2026-03-03T23:59:59Z');
            expect((await service.get({ days: 7 }, NOW)).jobs.total).toBe(2);
            expect((await service.get({ days: 1 }, NOW)).jobs.total).toBe(1);
            expect((await service.get({ days: 30 }, NOW)).jobs.total).toBe(3);
        });

        it('filters by projectId and repoId, including their runs', async () => {
            const a = await seedJob('queued', '2026-03-09T10:00:00Z');
            const b = await seedJob('queued', '2026-03-09T10:00:00Z', {}, otherRepo);
            await seedRun(a, 1);
            await seedRun(b, 1);
            await seedRun(b, 2);

            expect(await service.get({ days: 30, projectId: repo.projectId }, NOW)).toMatchObject({ jobs: { total: 1 }, runs: { total: 1 } });
            expect(await service.get({ days: 30, repoId: otherRepo.id }, NOW)).toMatchObject({ jobs: { total: 1 }, runs: { total: 2 } });
            expect((await service.get({ days: 30 }, NOW)).jobs.total).toBe(2);
        });

        it('throws NotFound for an unknown projectId or repoId', async () => {
            await expect(service.get({ days: 30, projectId: UNKNOWN }, NOW)).rejects.toBeInstanceOf(NotFoundException);
            await expect(service.get({ days: 30, repoId: UNKNOWN }, NOW)).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
