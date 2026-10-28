import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { User } from '../user/user.entity.js';
import { JobDependency } from './job-dependency.entity.js';
import type { JobStatus } from './job-state.js';
import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { JobService } from './job.service.js';

let ds: DataSource;
let jobs: Repository<Job>;
let deps: Repository<JobDependency>;
let service: JobService;
let repo: Repo;
let user: User;
let feature: Feature;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobDependency, Feature, JobRevision], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    deps = ds.getRepository(JobDependency);
    const project = await ds.getRepository(Project).save({ slug: 'p', name: 'P' } as Partial<Project>);
    repo = await ds.getRepository(Repo).save({ projectId: project.id, fullName: 'o/a', testCommands: ['x'] } as Partial<Repo>);
    user = await ds.getRepository(User).save({ name: 'Ann', email: 'ann@example.com', password: 'x' } as Partial<User>);
    feature = await ds.getRepository(Feature).save({ projectId: project.id, title: 'F', spec: 's', status: 'active' } as Partial<Feature>);
    const repoService = { getById: (id: string) => ds.getRepository(Repo).findOneByOrFail({ id }) };
    service = new JobService(new JobMapper(), repoService as never, {} as never, {} as never, jobs, deps, ds.getRepository(Feature));
});
afterEach(() => ds.destroy());

const seed = (status: JobStatus, over: Partial<Job> = {}) =>
    jobs.save(jobs.create({ projectId: repo.projectId, repoId: repo.id, title: `J-${status}`, task: 'a task text', status, queuedAt: new Date(), ...over }));
const mergedBlocked = (over: Partial<Job> = {}) => seed('merged', {
    mergedBlocked: true, featureId: feature.id, acceptanceCriteria: ['one', 'two'], attempts: 2, prNumber: 9, prUrl: 'http://pr',
    branch: 'claude/x', headSha: 'abc', needsApproval: true, approvalReason: 'r', lastReason: 'old', createdById: null, ...over,
});
const edges = async () => (await deps.find()).map((e) => `${e.jobId}>${e.dependsOnJobId}`).sort();

describe('mergedBlocked in dependencies', () => {
    it('keeps a merged-blocked prerequisite in blockedBy with failedDependency, while a plain merge drops out', async () => {
        const blocked = await mergedBlocked();
        const fine = await seed('merged');
        const job = await seed('queued');
        await deps.insert([{ jobId: job.id, dependsOnJobId: blocked.id }, { jobId: job.id, dependsOnJobId: fine.id }]);

        const list = await service.list({ projectId: repo.projectId, limit: 50 });
        const dto = list.find((j) => j.id === job.id)!;
        expect(dto.blockedBy).toEqual([{ id: blocked.id, title: blocked.title, status: 'merged', mergedBlocked: true }]);
        expect(dto.failedDependency).toBe(true);
        expect((await service.getById(job.id)).blockedBy).toEqual(dto.blockedBy);
        expect(list.find((j) => j.id === blocked.id)!.mergedBlocked).toBe(true);
        expect(list.find((j) => j.id === fine.id)!.mergedBlocked).toBe(false);
    });

    it('mergedBlocked is false unless the job is merged', async () => {
        const stale = await seed('parked', { mergedBlocked: true });
        expect((await service.getById(stale.id)).mergedBlocked).toBe(false);
    });
});

describe('statusSnapshot', () => {
    it('counts merged-without-work exactly, bounds the ids and keeps the merged count factual', async () => {
        for (let i = 0; i < 3; i++) await mergedBlocked();
        await seed('merged');
        const snap = await service.statusSnapshot(repo.projectId, 2);
        expect(snap.counts.merged).toBe(4);
        expect(snap.mergedWithoutWork.count).toBe(3);
        expect(snap.mergedWithoutWork.ids).toHaveLength(2);
    });
});

describe('recreate', () => {
    it('creates a triage copy with content, feature, own prerequisites and fresh runtime state, attributed to the actor', async () => {
        const prereq = await seed('merged');
        const source = await mergedBlocked({ createdById: null });
        await deps.insert({ jobId: source.id, dependsOnJobId: prereq.id });

        const created = await service.recreate(source.id, user);
        expect(created).toMatchObject({
            status: 'triage', title: source.title, task: source.task, acceptanceCriteria: ['one', 'two'], featureId: feature.id,
            repoId: repo.id, projectId: repo.projectId, attempts: 0, prNumber: null, prUrl: null, branch: null, lastReason: null,
            needsApproval: false, approvalReason: null, queuedAt: null, mergedBlocked: false, recreatedFromId: source.id,
            createdBy: { id: user.id, name: 'Ann' }, dependsOn: [prereq.id],
        });
        expect(created.id).not.toBe(source.id);
        const original = await service.getById(source.id);
        expect(original).toMatchObject({ status: 'merged', prNumber: 9, attempts: 2, mergedBlocked: true, replacedById: created.id });
        expect(original.createdAt).toBe(source.createdAt.toISOString());
    });

    it('rewires dependents of every status, keeps their other edges, and starts none of them', async () => {
        const source = await mergedBlocked();
        const other = await seed('queued');
        const statuses: JobStatus[] = ['triage', 'queued', 'dispatched', 'pr_open', 'parked'];
        const dependents = await Promise.all(statuses.map((s) => seed(s)));
        for (const d of dependents) await deps.insert({ jobId: d.id, dependsOnJobId: source.id });
        await deps.insert({ jobId: dependents[0]!.id, dependsOnJobId: other.id });

        const created = await service.recreate(source.id, user);
        const after = await edges();
        for (const d of dependents) expect(after).toContain(`${d.id}>${created.id}`);
        expect(after.filter((e) => e.endsWith(`>${source.id}`))).toEqual([]);
        expect(after).toContain(`${dependents[0]!.id}>${other.id}`);
        expect(after).toHaveLength(dependents.length + 1);
        for (const d of dependents) expect((await jobs.findOneByOrFail({ id: d.id })).status).toBe(d.status);
        // the dependents now wait for a replacement that is in triage
        expect((await service.getById(dependents[1]!.id)).blockedBy.map((b) => b.id)).toEqual([created.id]);
    });

    it('rejects ineligible sources with 409 and unknown ids with 404', async () => {
        for (const s of ['queued', 'parked', 'pr_open', 'rejected', 'cancelled', 'triage'] as JobStatus[]) {
            await expect(service.recreate((await seed(s, { mergedBlocked: true })).id)).rejects.toThrow(ConflictException);
        }
        await expect(service.recreate((await seed('merged')).id)).rejects.toThrow(ConflictException); // merged with work
        await expect(service.recreate('00000000-0000-4000-8000-000000000000')).rejects.toThrow(NotFoundException);
    });

    it('repeated and concurrent requests give one replacement and one set of edges', async () => {
        const source = await mergedBlocked();
        const dependent = await seed('queued');
        await deps.insert({ jobId: dependent.id, dependsOnJobId: source.id });

        const results = await Promise.allSettled([service.recreate(source.id, user), service.recreate(source.id, user), service.recreate(source.id, user)]);
        const ids = new Set(results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
        expect(ids.size).toBe(1);
        expect(await jobs.countBy({ recreatedFromId: source.id })).toBe(1);
        expect(await edges()).toEqual([`${dependent.id}>${[...ids][0]}`]);
        const again = await service.recreate(source.id, user);
        expect(again.id).toBe([...ids][0]);
    });

    it('rolls back the copy and the rewiring together on failure', async () => {
        const source = await mergedBlocked();
        const dependent = await seed('queued');
        await deps.insert({ jobId: dependent.id, dependsOnJobId: source.id });
        const before = await jobs.count();
        const original = ds.manager.update.bind(ds.manager);
        // Fail the rewiring step, which runs after the copy has been inserted in the same transaction.
        ds.manager.transaction = (async (run: (m: unknown) => Promise<unknown>) => {
            const real = ds.createQueryRunner();
            await real.connect();
            await real.startTransaction();
            try {
                const m = real.manager;
                m.update = (async (...args: Parameters<typeof original>) => {
                    if (args[0] === JobDependency) throw new Error('boom');
                    return original(...args);
                }) as never;
                const out = await run(m);
                await real.commitTransaction();
                return out;
            } catch (e) {
                await real.rollbackTransaction();
                throw e;
            } finally {
                await real.release();
            }
        }) as never;
        await expect(service.recreate(source.id, user)).rejects.toThrow('boom');
        expect(await jobs.count()).toBe(before);
        expect(await edges()).toEqual([`${dependent.id}>${source.id}`]);
    });
});
