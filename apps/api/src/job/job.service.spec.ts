import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
        type: 'better-sqlite3', database: ':memory:', entities: [Project, Repo, Job, JobDependency], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    const projects = ds.getRepository(Project);
    const repos = ds.getRepository(Repo);
    const p1 = await projects.save(projects.create({ slug: 'p1', name: 'P1' }));
    const p2 = await projects.save(projects.create({ slug: 'p2', name: 'P2' }));
    const mk = (p: Project, n: string) => repos.save(repos.create({ projectId: p.id, fullName: `o/${n}`, testCommand: 'x' }));
    repoA = await mk(p1, 'a');
    repoB = await mk(p1, 'b');
    other = await mk(p2, 'c');
    const repoService = { getById: (id: string) => repos.findOneByOrFail({ id }) };
    service = new JobService(
        new JobMapper(), repoService as never, {} as never, {} as never, jobs, ds.getRepository(JobDependency),
    );
});

afterEach(() => ds.destroy());

const body = (over: object = {}) => ({ title: 'Some job', task: 'do the thing please', ...over });
async function seed(repo: Repo, status: JobStatus = 'queued') {
    return jobs.save(jobs.create({ projectId: repo.projectId, repoId: repo.id, title: `J-${status}`, task: 't', status, queuedAt: new Date() }));
}

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
        const updated = await service.update(t.id, { title: 'New title', acceptanceCriteria: ['one'] });
        expect(updated).toMatchObject({ title: 'New title', acceptanceCriteria: ['one'] });
        const q = await seed(repoA, 'queued');
        await expect(service.update(q.id, { title: 'New title' })).rejects.toThrow(ConflictException);
    });

    it('edits dependencies in triage as well as queued', async () => {
        const dep = await seed(repoA, 'merged');
        const t = await seed(repoA, 'triage');
        expect((await service.setDependencies(t.id, [dep.id])).dependsOn).toEqual([dep.id]);
    });
});
