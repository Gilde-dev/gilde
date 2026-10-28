import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { User } from '../user/user.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobDependency } from './job-dependency.entity.js';
import type { JobStatus } from './job-state.js';
import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { JobService } from './job.service.js';

let ds: DataSource;
let jobs: Repository<Job>;
let service: JobService;
let repoA: Repo;
let repoB: Repo;
let other: Repo;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobDependency, Feature, JobRevision], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    const projects = ds.getRepository(Project);
    const repos = ds.getRepository(Repo);
    const p1 = await projects.save(projects.create({ slug: 'p1', name: 'P1' }));
    const p2 = await projects.save(projects.create({ slug: 'p2', name: 'P2' }));
    const mk = (p: Project, n: string) => repos.save(repos.create({ projectId: p.id, fullName: `o/${n}`, testCommands: ['x'] }));
    repoA = await mk(p1, 'a');
    repoB = await mk(p1, 'b');
    other = await mk(p2, 'c');
    const repoService = { getById: (id: string) => repos.findOneByOrFail({ id }) };
    service = new JobService(
        new JobMapper(), repoService as never, {} as never, {} as never, jobs, ds.getRepository(JobDependency), ds.getRepository(Feature),
    );
});

afterEach(() => ds.destroy());

const body = (over: object = {}) => ({ title: 'Some job', task: 'do the thing please', ...over });
async function seed(repo: Repo, status: JobStatus = 'queued') {
    return jobs.save(jobs.create({ projectId: repo.projectId, repoId: repo.id, title: `J-${status}`, task: 't', status, queuedAt: new Date() }));
}

/** A full replacement body that resends the stored job unchanged. */
const full = (j: Job) => ({ title: j.title, task: j.task, acceptanceCriteria: j.acceptanceCriteria ?? [], featureId: j.featureId ?? null });

describe('job dependencies', () => {
    it('allows cross-repo dependencies in the same project', async () => {
        const dep = await seed(repoB);
        const job = await service.create(repoA.id, body({ dependsOn: [dep.id] }));
        expect(job.dependsOn).toEqual([dep.id]);
    });

    it('rejects unknown, other-project, duplicate dependencies on create', async () => {
        const foreign = await seed(other);
        const dep = await seed(repoA);
        const unknown = '00000000-0000-4000-8000-000000000000';
        await expect(service.create(repoA.id, body({ dependsOn: [unknown] }))).rejects.toThrow(BadRequestException);
        await expect(service.create(repoA.id, body({ dependsOn: [foreign.id] }))).rejects.toThrow(BadRequestException);
        await expect(service.create(repoA.id, body({ dependsOn: [dep.id, dep.id] }))).rejects.toThrow(BadRequestException);
    });

    it('rejects a self-dependency', async () => {
        const job = await seed(repoA);
        await expect(service.setDependencies(job.id, [job.id])).rejects.toThrow(BadRequestException);
    });

    it('rejects a cycle with the path, and non-queued jobs with 409', async () => {
        const a = await seed(repoA);
        const b = await seed(repoA);
        await service.setDependencies(a.id, [b.id]);
        await expect(service.setDependencies(b.id, [a.id])).rejects.toThrow(/cycle: .*->/);
        await jobs.update({ id: a.id }, { status: 'dispatched' });
        await expect(service.setDependencies(a.id, [])).rejects.toThrow(ConflictException);
    });

    it('reports blockedBy and failedDependency in list and detail', async () => {
        const merged = await seed(repoA, 'merged');
        const open = await seed(repoA, 'pr_open');
        const bad = await seed(repoA, 'rejected');
        const job = await seed(repoA);
        const plain = await seed(repoA, 'queued');
        await service.setDependencies(job.id, [merged.id, open.id]);

        const detail = await service.getById(job.id);
        expect(detail.dependsOn.sort()).toEqual([merged.id, open.id].sort());
        expect(detail.blockedBy).toEqual([{ id: open.id, title: open.title, status: 'pr_open' }]);
        expect(detail.failedDependency).toBeUndefined();

        await service.setDependencies(job.id, [bad.id]);
        const list = await service.list({ limit: 50 });
        expect(list.find((j) => j.id === job.id)).toMatchObject({ failedDependency: true, blockedBy: [{ id: bad.id }] });
        expect(list.find((j) => j.id === plain.id)).toMatchObject({ dependsOn: [], blockedBy: [] });
    });
});

describe('triage', () => {
    it('creates queued with queuedAt by default, and triage without queuedAt until enqueue', async () => {
        const q = await service.create(repoA.id, body());
        expect(q.status).toBe('queued');
        expect(q.queuedAt).not.toBeNull();
        const t = await service.create(repoA.id, body({ status: 'triage' }));
        expect(t.status).toBe('triage');
        expect(t.queuedAt).toBeNull();
        const enq = await service.enqueue(t.id);
        expect(enq.status).toBe('queued');
        expect(enq.queuedAt).not.toBeNull();
        expect(enq.warnings).toEqual([]);
        const back = await service.toTriage(t.id);
        expect(back).toMatchObject({ status: 'triage', queuedAt: null });
    });

    it('rejects enqueue of a non-triage job and triage of a non-queued job with 409', async () => {
        const q = await seed(repoA, 'queued');
        const d = await seed(repoA, 'dispatched');
        await expect(service.enqueue(q.id)).rejects.toThrow(ConflictException);
        await expect(service.toTriage(d.id)).rejects.toThrow(ConflictException);
    });

    it('bulk enqueue queues all, or nothing when one id is not in triage', async () => {
        const a = await seed(repoA, 'triage');
        const b = await seed(repoA, 'triage');
        const c = await seed(repoA, 'queued');
        const err = await service.enqueueMany([a.id, b.id, c.id]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({ ids: [c.id] });
        expect((await jobs.findOneByOrFail({ id: a.id })).status).toBe('triage');
        expect((await jobs.findOneByOrFail({ id: b.id })).status).toBe('triage');

        const res = await service.enqueueMany([a.id, b.id]);
        expect(res.map((j) => j.status)).toEqual(['queued', 'queued']);
        expect((await jobs.findOneByOrFail({ id: a.id })).queuedAt).not.toBeNull();
    });

    it('bulk enqueue is 404 for unknown ids and queues nothing', async () => {
        const a = await seed(repoA, 'triage');
        await expect(service.enqueueMany([a.id, '00000000-0000-4000-8000-000000000000'])).rejects.toThrow(/not found/);
        expect((await jobs.findOneByOrFail({ id: a.id })).status).toBe('triage');
    });

    it('warns on enqueue when a dependency is still in triage', async () => {
        const dep = await seed(repoA, 'triage');
        const job = await service.create(repoA.id, body({ status: 'triage', dependsOn: [dep.id] }));
        const res = await service.enqueue(job.id);
        expect(res.warnings).toEqual([expect.objectContaining({ dependencyId: dep.id })]);
    });

    it('edits title, task and criteria only in triage', async () => {
        const t = await seed(repoA, 'triage');
        const updated = await service.update(t.id, { title: 'New title', task: t.task, acceptanceCriteria: ['one'], featureId: null });
        expect(updated).toMatchObject({ title: 'New title', acceptanceCriteria: ['one'], featureId: null });
        const q = await seed(repoA, 'queued');
        await expect(service.update(q.id, { title: 'New title', task: q.task, acceptanceCriteria: [], featureId: null })).rejects.toThrow(ConflictException);
        // Resending the stored content is not an edit, so a queued job accepts it.
        await expect(service.update(q.id, { title: q.title, task: q.task, acceptanceCriteria: q.acceptanceCriteria ?? [], featureId: null })).resolves.toMatchObject({ id: q.id });
        const d = await seed(repoA, 'dispatched');
        await expect(service.update(d.id, { title: d.title, task: d.task, acceptanceCriteria: d.acceptanceCriteria ?? [], featureId: null })).rejects.toThrow(ConflictException);
    });

    describe('feature link on update', () => {
        const mkFeature = (status: Feature['status'] = 'active') => ds.getRepository(Feature).save(
            ds.getRepository(Feature).create({ projectId: repoA.projectId, title: 'F', spec: 's', status }),
        );

        it('looks nothing up for an unchanged link, even when the feature has since closed', async () => {
            const f = await mkFeature();
            const t = await seed(repoA, 'triage');
            await service.update(t.id, { ...full(t), featureId: f.id });
            await ds.getRepository(Feature).update({ id: f.id }, { status: 'done' });
            const stored = await jobs.findOneByOrFail({ id: t.id });
            await expect(service.update(t.id, { ...full(stored), title: 'Renamed' })).resolves.toMatchObject({ title: 'Renamed', featureId: f.id });
        });

        it('clears the link on null and leaves it on absent', async () => {
            const f = await mkFeature();
            const t = await seed(repoA, 'triage');
            await service.update(t.id, { ...full(t), featureId: f.id });
            const stored = await jobs.findOneByOrFail({ id: t.id });
            await expect(service.update(t.id, { ...full(stored), featureId: undefined } as never)).resolves.toMatchObject({ featureId: f.id });
            await expect(service.update(t.id, { ...full(stored), featureId: null })).resolves.toMatchObject({ featureId: null });
        });

        it('validates a changed link and lets a queued job change only its feature', async () => {
            const f = await mkFeature();
            const t = await seed(repoA, 'queued');
            const unknown = '00000000-0000-4000-8000-000000000000';
            await expect(service.update(t.id, { ...full(t), featureId: unknown })).rejects.toThrow(BadRequestException);
            await expect(service.update(t.id, { ...full(t), featureId: f.id })).resolves.toMatchObject({ featureId: f.id });
            await expect(service.update(t.id, { ...full(t), title: 'Edit' })).rejects.toThrow(ConflictException);
        });
    });

    describe('task and criteria size', () => {
        const size = (task: number, ...criteria: number[]) => ({ task: 't'.repeat(task), acceptanceCriteria: criteria.map((n) => 'c'.repeat(n)) });

        it('accepts exactly 40000 characters and rejects 40001, counting every criterion, on create', async () => {
            await expect(service.create(repoA.id, body(size(39_999)))).resolves.toBeDefined();
            await expect(service.create(repoA.id, body(size(40_000)))).resolves.toBeDefined();
            await expect(service.create(repoA.id, body(size(30_000, 5_000, 5_000)))).resolves.toBeDefined();
            const before = await jobs.count();
            await expect(service.create(repoA.id, body(size(40_001)))).rejects.toThrow(BadRequestException);
            await expect(service.create(repoA.id, body(size(30_000, 5_000, 5_001)))).rejects.toThrow(/40001 characters together.*over the 40000 limit.*shorten/);
            expect(await jobs.count()).toBe(before);
            expect(await ds.getRepository(JobDependency).count()).toBe(0);
        });

        it('checks the effective content of a partial update and leaves the job untouched when rejected', async () => {
            const t = await jobs.save(jobs.create({ projectId: repoA.projectId, repoId: repoA.id, title: 'T', task: 't'.repeat(30_000), acceptanceCriteria: ['c'.repeat(9_999)], status: 'triage' }));
            await expect(service.update(t.id, { ...full(t), title: 'Renamed' })).resolves.toMatchObject({ title: 'Renamed' });
            await expect(service.update(t.id, { ...full(t), acceptanceCriteria: ['c'.repeat(10_001)] })).rejects.toThrow(BadRequestException);
            await expect(service.update(t.id, { ...full(t), task: 't'.repeat(30_002) })).rejects.toThrow(BadRequestException);
            await expect(service.update(t.id, { ...full(t), title: 'No write', task: 't'.repeat(30_002) })).rejects.toThrow(BadRequestException);
            expect(await jobs.findOneByOrFail({ id: t.id })).toMatchObject({ title: 'Renamed', task: 't'.repeat(30_000) });
            await expect(service.update(t.id, { ...full(t), task: 't'.repeat(30_001) })).resolves.toMatchObject({ task: 't'.repeat(30_001) });
        });

        it('does not block unrelated edits of a legacy oversized job, nor change who may edit', async () => {
            const legacy = await jobs.save(jobs.create({ projectId: repoA.projectId, repoId: repoA.id, title: 'L', task: 't'.repeat(50_000), status: 'triage' }));
            await expect(service.update(legacy.id, { ...full(legacy), title: 'Still editable' })).resolves.toMatchObject({ title: 'Still editable' });
            const queued = await seed(repoA, 'queued');
            await expect(service.update(queued.id, { ...full(queued), task: 't'.repeat(50_000) })).rejects.toThrow(ConflictException);
        });
    });

    it('edits dependencies in triage as well as queued', async () => {
        const dep = await seed(repoA, 'merged');
        const t = await seed(repoA, 'triage');
        expect((await service.setDependencies(t.id, [dep.id])).dependsOn).toEqual([dep.id]);
    });
});

describe('createdBy', () => {
    const users = () => ds.getRepository(User);
    const mkUser = (name: string) => users().save(users().create({ name, email: `${name}@x.nl`, password: 'x' }));

    it('stores the actor, defaults to null, and reports the creator in list and detail', async () => {
        const ann = await mkUser('ann');
        const mine = await service.create(repoA.id, body(), { id: ann.id });
        const system = await service.create(repoA.id, body());
        expect(mine.createdBy).toEqual({ id: ann.id, name: 'ann' });
        expect(system.createdBy).toBeNull();
        expect((await service.getById(mine.id)).createdBy).toEqual({ id: ann.id, name: 'ann' });
        const list = await service.list({ limit: 50 });
        expect(list.find((j) => j.id === mine.id)?.createdBy).toEqual({ id: ann.id, name: 'ann' });
        expect(list.find((j) => j.id === system.id)?.createdBy).toBeNull();
    });

    it('filters by user id and by me', async () => {
        const ann = await mkUser('ann');
        const bob = await mkUser('bob');
        const a = await service.create(repoA.id, body(), { id: ann.id });
        const b = await service.create(repoA.id, body(), { id: bob.id });
        expect((await service.list({ limit: 50, createdBy: 'me' }, { id: ann.id })).map((j) => j.id)).toEqual([a.id]);
        expect((await service.list({ limit: 50, createdBy: bob.id })).map((j) => j.id)).toEqual([b.id]);
        expect(await service.list({ limit: 50, createdBy: 'me' }, null)).toEqual([]);
    });

    it('sets created_by to null when the user is deleted', async () => {
        const ann = await mkUser('ann');
        const job = await service.create(repoA.id, body(), { id: ann.id });
        await users().delete({ id: ann.id });
        expect((await service.getById(job.id)).createdBy).toBeNull();
    });
});
