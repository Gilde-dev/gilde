import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobDependency } from '../job/job-dependency.entity.js';
import type { JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { JobMapper } from '../job/job.mapper.js';
import { JobService } from '../job/job.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { Feature } from './feature.entity.js';
import { FeatureMapper } from './feature.mapper.js';
import { FeatureService } from './feature.service.js';
import type { FeatureStatus } from './feature-state.js';

let ds: DataSource;
let jobs: Repository<Job>;
let features: Repository<Feature>;
let jobService: JobService;
let service: FeatureService;
let p1: Project;
let repoA: Repo;
let repoB: Repo;
let foreign: Repo;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [Project, Repo, Job, JobDependency, Feature], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    features = ds.getRepository(Feature);
    const projects = ds.getRepository(Project);
    const repos = ds.getRepository(Repo);
    p1 = await projects.save(projects.create({ slug: 'p1', name: 'P1' }));
    const p2 = await projects.save(projects.create({ slug: 'p2', name: 'P2' }));
    const mk = (p: Project, n: string) => repos.save(repos.create({ projectId: p.id, fullName: `o/${n}`, testCommands: ['x'] }));
    repoA = await mk(p1, 'a');
    repoB = await mk(p1, 'b');
    foreign = await mk(p2, 'c');
    const repoService = { getById: (id: string) => repos.findOneByOrFail({ id }) };
    jobService = new JobService(new JobMapper(), repoService as never, {} as never, {} as never, jobs, ds.getRepository(JobDependency), features);
    service = new FeatureService(new FeatureMapper(), { getById: async () => p1 } as never, jobService, features, jobs);
});

afterEach(() => ds.destroy());

const body = (over: object = {}) => ({ title: 'Some job', task: 'do the thing please', ...over });
const mkFeature = (status: FeatureStatus = 'draft', over: Partial<Feature> = {}) =>
    features.save(features.create({ projectId: p1.id, title: 'F', spec: 'spec', status, ...over }));
const seed = (repo: Repo, featureId: string | null, status: JobStatus, attempts = 0) =>
    jobs.save(jobs.create({ projectId: repo.projectId, repoId: repo.id, featureId, title: `J-${status}`, task: 't', status, attempts, queuedAt: new Date() }));

describe('jobs and features', () => {
    it('defaults to triage in a draft feature and rejects queued with 409', async () => {
        const f = await mkFeature('draft');
        expect((await jobService.create(repoA.id, body({ featureId: f.id }))).status).toBe('triage');
        await expect(jobService.create(repoA.id, body({ featureId: f.id, status: 'queued' }))).rejects.toThrow(ConflictException);
    });

    it('queues by default in an active feature', async () => {
        const f = await mkFeature('active');
        expect((await jobService.create(repoA.id, body({ featureId: f.id }))).status).toBe('queued');
    });

    it('rejects done and cancelled features with 409, and other-project or unknown ones with 400', async () => {
        for (const status of ['done', 'cancelled'] as const) {
            const f = await mkFeature(status);
            await expect(jobService.create(repoA.id, body({ featureId: f.id }))).rejects.toThrow(ConflictException);
        }
        const f = await mkFeature('active');
        await expect(jobService.create(foreign.id, body({ featureId: f.id }))).rejects.toThrow(BadRequestException);
        await expect(jobService.create(repoA.id, body({ featureId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(BadRequestException);
    });

    it('links and unlinks through update while in triage or queued, not later', async () => {
        const f = await mkFeature('active');
        const triage = await seed(repoA, null, 'triage');
        const queued = await seed(repoA, null, 'queued');
        const running = await seed(repoA, null, 'dispatched');
        expect((await jobService.update(triage.id, { featureId: f.id })).featureId).toBe(f.id);
        expect((await jobService.update(queued.id, { featureId: f.id })).featureId).toBe(f.id);
        expect((await jobService.update(queued.id, { featureId: null })).featureId).toBeNull();
        await expect(jobService.update(running.id, { featureId: f.id })).rejects.toThrow(ConflictException);
        await expect(jobService.update(queued.id, { title: 'new title' })).rejects.toThrow(ConflictException);
        const foreignJob = await seed(foreign, null, 'triage');
        await expect(jobService.update(foreignJob.id, { featureId: f.id })).rejects.toThrow(BadRequestException);
        const draft = await mkFeature('draft');
        await expect(jobService.update(queued.id, { featureId: draft.id })).rejects.toThrow(ConflictException);
    });
});

describe('FeatureService', () => {
    it('start activates the feature and queues all its triage jobs', async () => {
        const f = await mkFeature('draft');
        const a = await seed(repoA, f.id, 'triage');
        const b = await seed(repoB, f.id, 'triage');
        const unrelated = await seed(repoA, null, 'triage');
        const res = await service.start(f.id);
        expect(res.status).toBe('active');
        expect(res.startedAt).not.toBeNull();
        expect(res.warnings).toEqual([]);
        expect((await jobs.findOneByOrFail({ id: a.id })).status).toBe('queued');
        expect((await jobs.findOneByOrFail({ id: b.id })).status).toBe('queued');
        expect((await jobs.findOneByOrFail({ id: unrelated.id })).status).toBe('triage');
    });

    it('start is atomic: a failing enqueue leaves the feature draft', async () => {
        const f = await mkFeature('draft');
        const a = await seed(repoA, f.id, 'triage');
        const orig = jobService.enqueueManyIn.bind(jobService);
        jobService.enqueueManyIn = async (m, ids) => {
            await orig(m, ids);
            throw new ConflictException('boom');
        };
        await expect(service.start(f.id)).rejects.toThrow(ConflictException);
        expect((await features.findOneByOrFail({ id: f.id })).status).toBe('draft');
        expect((await jobs.findOneByOrFail({ id: a.id })).status).toBe('triage');
    });

    it('start returns warnings for dependencies still in triage elsewhere', async () => {
        const f = await mkFeature('draft');
        const dep = await seed(repoA, null, 'triage');
        const job = await seed(repoA, f.id, 'triage');
        await ds.getRepository(JobDependency).save({ jobId: job.id, dependsOnJobId: dep.id });
        const res = await service.start(f.id);
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings[0].dependencyId).toBe(dep.id);
    });

    it('rejects invalid transitions with 409', async () => {
        const draft = await mkFeature('draft');
        await expect(service.done(draft.id)).rejects.toThrow(ConflictException);
        await expect(service.reopen(draft.id)).rejects.toThrow(ConflictException);
        await service.start(draft.id);
        await expect(service.start(draft.id)).rejects.toThrow(ConflictException);
        await service.done(draft.id);
        await expect(service.cancel(draft.id)).rejects.toThrow(ConflictException);
        await expect(service.update(draft.id, { title: 'nope nope' })).rejects.toThrow(ConflictException);
        const cancelled = await mkFeature('cancelled');
        await expect(service.reopen(cancelled.id)).rejects.toThrow(ConflictException);
    });

    it('done lists open jobs, sets done_at, and reopen clears it', async () => {
        const f = await mkFeature('active', { startedAt: new Date() });
        await seed(repoA, f.id, 'merged');
        const open = await seed(repoA, f.id, 'pr_open');
        const res = await service.done(f.id);
        expect(res.status).toBe('done');
        expect(res.doneAt).not.toBeNull();
        expect(res.openJobs.map((j) => j.id)).toEqual([open.id]);
        const reopened = await service.reopen(f.id);
        expect(reopened.status).toBe('active');
        expect(reopened.doneAt).toBeNull();
    });

    it('cancel cancels triage and queued jobs only and reports the active ones', async () => {
        const f = await mkFeature('active');
        const triage = await seed(repoA, f.id, 'triage');
        const queued = await seed(repoA, f.id, 'queued');
        const running = await seed(repoA, f.id, 'dispatched');
        const merged = await seed(repoA, f.id, 'merged');
        const res = await service.cancel(f.id);
        expect(res.status).toBe('cancelled');
        expect(res.cancelledJobs.map((j) => j.id).sort()).toEqual([triage.id, queued.id].sort());
        expect(res.activeJobs.map((j) => j.id)).toEqual([running.id]);
        expect((await jobs.findOneByOrFail({ id: running.id })).status).toBe('dispatched');
        expect((await jobs.findOneByOrFail({ id: merged.id })).status).toBe('merged');
        expect((await jobs.findOneByOrFail({ id: triage.id })).status).toBe('cancelled');
    });

    it('update edits draft and active features', async () => {
        const f = await mkFeature('draft');
        const res = await service.update(f.id, { title: 'Renamed', acceptanceCriteria: ['one more'] });
        expect(res.title).toBe('Renamed');
        expect(res.acceptanceCriteria).toEqual(['one more']);
    });

    describe('progress', () => {
        it('excludes cancelled jobs and flags readyToClose', async () => {
            const f = await mkFeature('active', { startedAt: new Date(Date.now() - 90 * 60_000) });
            await seed(repoA, f.id, 'merged', 2);
            await seed(repoA, f.id, 'merged', 1);
            await seed(repoA, f.id, 'cancelled', 3);
            const p = (await service.getDetail(f.id)).progress;
            expect(p.total).toBe(2);
            expect(p.merged).toBe(2);
            expect(p.countByStatus.cancelled).toBe(1);
            expect(p.readyToClose).toBe(true);
            expect(p.attempts).toBe(6);
            expect(p.leadTimeMinutes).toBe(90);
        });

        it('is not ready with open jobs, with no jobs, or when the feature is not active', async () => {
            const open = await mkFeature('active');
            await seed(repoA, open.id, 'merged');
            await seed(repoA, open.id, 'queued');
            const empty = await mkFeature('active');
            const onlyCancelled = await mkFeature('active');
            await seed(repoA, onlyCancelled.id, 'cancelled');
            const done = await mkFeature('done');
            await seed(repoA, done.id, 'merged');
            const byId = new Map((await service.list(p1.id, {})).map((f) => [f.id, f.progress]));
            expect(byId.get(open.id)!.readyToClose).toBe(false);
            expect(byId.get(empty.id)!.readyToClose).toBe(false);
            expect(byId.get(onlyCancelled.id)!.readyToClose).toBe(false);
            expect(byId.get(done.id)!.readyToClose).toBe(false);
        });

        it('measures lead time to done_at and is null before start; list filters by status', async () => {
            const start = new Date('2026-01-01T10:00:00Z');
            const done = await mkFeature('done', { startedAt: start, doneAt: new Date('2026-01-01T12:30:00Z') });
            const draft = await mkFeature('draft');
            const all = await service.list(p1.id, {});
            expect(all.find((f) => f.id === done.id)!.progress.leadTimeMinutes).toBe(150);
            expect(all.find((f) => f.id === draft.id)!.progress.leadTimeMinutes).toBeNull();
            expect((await service.list(p1.id, { status: 'draft' })).map((f) => f.id)).toEqual([draft.id]);
        });
    });
});
