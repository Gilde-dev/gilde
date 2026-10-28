import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDependency } from '../job/job-dependency.entity.js';
import { User } from '../user/user.entity.js';
import type { JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { JobMapper } from '../job/job.mapper.js';
import type { ReplaceJobDto } from '../job/job.dto.js';
import { JobService } from '../job/job.service.js';
import { JobRevision } from '../revision/revision.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { Notification } from '../notification/notification.entity.js';
import { NotificationMapper } from '../notification/notification.mapper.js';
import { NotificationService } from '../notification/notification.service.js';
import { Feature } from './feature.entity.js';
import { FeatureMapper } from './feature.mapper.js';
import { FeatureService } from './feature.service.js';
import type { FeatureStatus } from './feature-state.js';

let ds: DataSource;
let jobs: Repository<Job>;
let features: Repository<Feature>;
let jobService: JobService;
let service: FeatureService;
let notifications: Repository<Notification>;
let capture: NotificationCaptureService;
let p1: Project;
let repoA: Repo;
let repoB: Repo;
let foreign: Repo;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobDependency, Feature, JobRevision, Notification], synchronize: true,
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
    notifications = ds.getRepository(Notification);
    capture = new NotificationCaptureService(new NotificationService(notifications, new NotificationMapper()), repos, jobs, features);
    jobService = new JobService(new JobMapper(), repoService as never, {} as never, {} as never, jobs, ds.getRepository(JobDependency), features, undefined, capture);
    service = new FeatureService(new FeatureMapper(), { getById: async () => p1 } as never, jobService, features, jobs, capture);
});

afterEach(() => ds.destroy());

const body = (over: object = {}) => ({ title: 'Some job', task: 'do the thing please', ...over });
const mkFeature = (status: FeatureStatus = 'draft', over: Partial<Feature> = {}) =>
    features.save(features.create({ projectId: p1.id, title: 'F', spec: 'spec', status, ...over }));
const seed = (repo: Repo, featureId: string | null, status: JobStatus, attempts = 0) =>
    jobs.save(jobs.create({ projectId: repo.projectId, repoId: repo.id, featureId, title: `J-${status}`, task: 't', status, attempts, queuedAt: new Date() }));

const replaceJob = (job: Job, over: Partial<ReplaceJobDto> = {}) =>
    jobService.update(job.id, { title: job.title, task: job.task, acceptanceCriteria: job.acceptanceCriteria ?? [], featureId: job.featureId, ...over });

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
        expect((await replaceJob(triage, { featureId: f.id })).featureId).toBe(f.id);
        expect((await replaceJob(queued, { featureId: f.id })).featureId).toBe(f.id);
        expect((await replaceJob(queued, { featureId: null })).featureId).toBeNull();
        await expect(replaceJob(running, { featureId: f.id })).rejects.toThrow(ConflictException);
        await expect(replaceJob(running, {})).rejects.toThrow(ConflictException);
        await expect(replaceJob(queued, { title: 'new title' })).rejects.toThrow(ConflictException);
        const foreignJob = await seed(foreign, null, 'triage');
        await expect(replaceJob(foreignJob, { featureId: f.id })).rejects.toThrow(BadRequestException);
        const draft = await mkFeature('draft');
        await expect(replaceJob(queued, { featureId: draft.id })).rejects.toThrow(ConflictException);
    });

    it('keeps an unchanged feature link when only the content changes, even if the feature has closed since', async () => {
        const f = await mkFeature('active');
        const triage = await seed(repoA, f.id, 'triage');
        await features.update({ id: f.id }, { status: 'done' });
        expect(await replaceJob(triage, { title: 'edited title' })).toMatchObject({ title: 'edited title', featureId: f.id });
        await expect(replaceJob(triage, { featureId: f.id, title: 'again a title' })).resolves.toMatchObject({ title: 'again a title' });
        const other = await mkFeature('done');
        await expect(replaceJob(triage, { featureId: other.id })).rejects.toThrow(ConflictException);
    });

    it('allows a queued job to change feature when the content is resent unchanged, and rejects changed content', async () => {
        const f = await mkFeature('active');
        const queued = await seed(repoA, null, 'queued');
        expect((await replaceJob(queued, { featureId: f.id })).featureId).toBe(f.id);
        await expect(replaceJob(queued, { featureId: f.id, acceptanceCriteria: ['a different criterion'] })).rejects.toThrow(ConflictException);
        await expect(replaceJob(queued, { featureId: f.id, task: `${queued.task} extra` })).rejects.toThrow(ConflictException);
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
        await expect(service.update(draft.id, { title: 'nope nope', spec: 'spec', acceptanceCriteria: [] })).rejects.toThrow(ConflictException);
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
        const res = await service.update(f.id, { title: 'Renamed', spec: 'a new spec', acceptanceCriteria: ['one more'] });
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

describe('feature.ready_to_close notifications', () => {
    const rows = () => notifications.find({ order: { createdAt: 'ASC' } });
    const withPr = (id: string, n: number) => jobs.update({ id }, { prNumber: n, prUrl: `https://github.com/o/a/pull/${n}` });

    it('records when the last open job is cancelled, with the counted jobs only, repos and PRs', async () => {
        const f = await mkFeature('active', { title: 'Big feature' });
        const merged = await seed(repoA, f.id, 'merged');
        await withPr(merged.id, 4);
        await seed(repoB, f.id, 'merged');
        const open = await seed(repoA, f.id, 'queued');
        await jobService.cancel(open.id);

        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({
            kind: 'feature.ready_to_close', featureId: f.id, projectId: p1.id, title: 'Big feature', jobId: null,
            repos: ['o/a', 'o/b'], prLinks: [{ repo: 'o/a', number: 4, url: 'https://github.com/o/a/pull/4' }],
        });
        expect(all[0].reason).toContain('All 2 jobs merged');
    });

    it('records nothing while a counted job is unmerged, for rejected jobs, empty or all-cancelled features, or inactive features', async () => {
        const f = await mkFeature('active');
        const a = await seed(repoA, f.id, 'queued');
        await seed(repoA, f.id, 'merged');
        await capture.featureReadiness(f.id);
        await seed(repoA, f.id, 'rejected');
        await jobService.cancel(a.id);
        await capture.featureReadiness(f.id);
        expect(await notifications.count()).toBe(0); // the rejected job still counts

        const empty = await mkFeature('active');
        await capture.featureReadiness(empty.id);
        const onlyCancelled = await mkFeature('active');
        await jobService.cancel((await seed(repoA, onlyCancelled.id, 'queued')).id);
        const draft = await mkFeature('draft');
        await seed(repoA, draft.id, 'merged');
        await capture.featureReadiness(draft.id);
        await capture.featureReadiness('00000000-0000-4000-8000-000000000000');
        await capture.featureReadiness(null);
        expect(await notifications.count()).toBe(0);
    });

    it('deduplicates repeated and concurrent checks of the same ready job set', async () => {
        const f = await mkFeature('active');
        await seed(repoA, f.id, 'merged');
        await seed(repoB, f.id, 'merged');
        await Promise.all(Array.from({ length: 5 }, () => capture.featureReadiness(f.id)));
        await capture.featureReadiness(f.id);
        expect(await notifications.count()).toBe(1);
    });

    it('records a new event for a different ready job set, but not when the same set is reopened', async () => {
        const f = await mkFeature('active');
        await seed(repoA, f.id, 'merged');
        await capture.featureReadiness(f.id);
        await service.done(f.id);
        await service.reopen(f.id); // same ready set: no new event
        expect(await notifications.count()).toBe(1);

        await seed(repoA, f.id, 'merged');
        await capture.featureReadiness(f.id);
        expect(await notifications.count()).toBe(2);
        expect((await rows())[0].occurrenceKey).not.toBe((await rows())[1].occurrenceKey);
    });

    it('records when reopening a done feature whose jobs are all merged', async () => {
        const f = await mkFeature('done', { doneAt: new Date() });
        await seed(repoA, f.id, 'merged');
        await service.reopen(f.id);
        expect(await notifications.count()).toBe(1);
    });

    it('records when reassigning the last open job away from the feature, and not for the feature it joins', async () => {
        const f = await mkFeature('active');
        const g = await mkFeature('active');
        await seed(repoA, f.id, 'merged');
        const open = await seed(repoA, f.id, 'queued');
        await replaceJob(open, { featureId: g.id });
        const all = await rows();
        expect(all.map((n) => n.featureId)).toEqual([f.id]);
    });

    it('records when starting a feature whose jobs are already merged (lifecycle activation)', async () => {
        const f = await mkFeature('draft');
        await seed(repoA, f.id, 'merged');
        await service.start(f.id);
        expect(await notifications.count()).toBe(1);
    });

    it('never fails the cancel or update when the notification read or insert fails', async () => {
        const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const f = await mkFeature('active');
        await seed(repoA, f.id, 'merged');
        const open = await seed(repoA, f.id, 'queued');
        const read = vi.spyOn(features, 'findOneBy').mockRejectedValue(new Error('read down'));
        // JobService.cancel reads the job through its own repository; only the capture's feature read is forced to fail
        expect((await jobService.cancel(open.id)).status).toBe('cancelled');
        read.mockRestore();

        const insert = vi.spyOn(notifications, 'insert').mockRejectedValue(new Error('insert down'));
        const open2 = await seed(repoA, f.id, 'queued');
        await jobService.cancel(open2.id);
        expect((await jobs.findOneByOrFail({ id: open2.id })).status).toBe('cancelled');
        expect(await notifications.count()).toBe(0);
        expect(log).toHaveBeenCalled();
        insert.mockRestore();
        log.mockRestore();
    });
});

describe('JobService.statusSnapshot (board state source for the scout)', () => {
    it('counts every status of the whole project exactly, beyond the public list limit, and bounds the parked ids', async () => {
        await jobs.insert(Array.from({ length: 205 }, (_, i) => jobs.create({ projectId: p1.id, repoId: repoA.id, title: `J${i}`, task: 't', status: 'queued', queuedAt: new Date() })));
        const parked = await Promise.all([1, 2, 3].map(() => seed(repoA, null, 'parked')));
        await seed(foreign, null, 'parked'); // another project is not counted

        const snapshot = await jobService.statusSnapshot(p1.id, 2);
        expect(snapshot.counts.queued).toBe(205);
        expect(snapshot.counts.parked).toBe(3);
        expect(snapshot.counts.merged).toBe(0);
        expect(Object.keys(snapshot.counts)).toHaveLength(9);
        expect(snapshot.parkedIds).toHaveLength(2);
        expect(parked.map((j) => j.id)).toEqual(expect.arrayContaining(snapshot.parkedIds));
    });
});
