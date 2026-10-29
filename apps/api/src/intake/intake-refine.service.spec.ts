import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { Feedback } from '../feedback/feedback.entity.js';
import { Job } from '../job/job.entity.js';
import { Notification } from '../notification/notification.entity.js';
import { Project } from '../project/project.entity.js';
import { GithubInstallation } from '../repo/github-installation.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import { IntakeItem } from './intake-item.entity.js';
import { IntakeRefineRun } from './intake-refine-run.entity.js';
import { IntakeRefineService, MAX_REFINE_ATTEMPTS } from './intake-refine.service.js';

let ds: DataSource;
let items: Repository<IntakeItem>;
let service: IntakeRefineService;
let p1: Project;
let p2: Project;
let r1: Repo;
let r2: Repo;

async function add(project: Project, repo: Repo, number: number, over: Partial<IntakeItem> = {}, createdAt = new Date(2026, 0, number)) {
    const item = items.create({
        projectId: project.id, repoId: repo.id, source: 'github_issue', externalId: `I_${number}`, number, url: `https://github.com/${repo.fullName}/issues/${number}`,
        title: `Issue ${number}`, body: 'text', bodySha256: `sha-${number}`, labels: ['gilde:refine'], status: 'new', createdAt, ...over,
    });
    return items.save(item);
}

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', synchronize: true,
        entities: [User, Project, Repo, Job, JobRun, Feedback, Feature, Notification, GithubInstallation, IntakeItem, IntakeRefineRun],
    }).initialize();
    items = ds.getRepository(IntakeItem);
    const projects = ds.getRepository(Project);
    p1 = await projects.save(projects.create({ slug: 'p1', name: 'P1' }));
    p2 = await projects.save(projects.create({ slug: 'p2', name: 'P2' }));
    const repos = ds.getRepository(Repo);
    r1 = await repos.save(repos.create({ projectId: p1.id, fullName: 'o/one' }));
    r2 = await repos.save(repos.create({ projectId: p2.id, fullName: 'o/two' }));
    service = new IntakeRefineService(items, ds.getRepository(IntakeRefineRun));
});
afterEach(() => ds.destroy());

describe('IntakeRefineService.nextPerProject', () => {
    it('takes the oldest new item per project, with its repo', async () => {
        await add(p1, r1, 2);
        const oldest = await add(p1, r1, 1);
        const other = await add(p2, r2, 3);
        const next = await service.nextPerProject();
        expect(next.map((i) => i.id).sort()).toEqual([oldest.id, other.id].sort());
        expect(next.find((i) => i.id === oldest.id)?.repo?.fullName).toBe('o/one');
    });

    it('skips archived items', async () => {
        await add(p1, r1, 1, { archivedAt: new Date() });
        const next = await add(p1, r1, 2);
        expect((await service.nextPerProject()).map((i) => i.id)).toEqual([next.id]);
    });

    it('only picks status new: not refining, drafted, failed, withdrawn or ignored', async () => {
        for (const [n, status] of (['drafted', 'failed', 'withdrawn', 'ignored'] as const).entries()) await add(p1, r1, n + 1, { status });
        expect(await service.nextPerProject()).toEqual([]);
    });

    it('skips an item whose body sha is the one already refined', async () => {
        await add(p1, r1, 1, { bodySha256: 'same', refinedSha256: 'same' });
        const changed = await add(p1, r1, 2, { bodySha256: 'new', refinedSha256: 'old' });
        expect((await service.nextPerProject()).map((i) => i.id)).toEqual([changed.id]);
    });

    it('does not pick a second item of a project that has one refining, but still serves other projects', async () => {
        await add(p1, r1, 1, { status: 'refining' });
        await add(p1, r1, 2);
        const other = await add(p2, r2, 3);
        expect((await service.nextPerProject()).map((i) => i.id)).toEqual([other.id]);
    });
});

describe('IntakeRefineService runs and transitions', () => {
    it('begin claims a new item once, counts the attempt and the daily run', async () => {
        const item = await add(p1, r1, 1);
        const started = await service.begin(item);
        expect(started).toMatchObject({ status: 'refining', refineAttempts: 1 });
        expect(await service.begin(item)).toBeNull(); // already claimed
        expect(await service.runsToday(p1.id)).toBe(1);
        expect(await service.runsToday(p2.id)).toBe(0);
    });

    it('counts runs per UTC day', async () => {
        const item = await add(p1, r1, 1);
        await service.begin(item);
        const now = new Date();
        expect(await service.runsToday(p1.id, now)).toBe(1);
        expect(await service.runsToday(p1.id, new Date(now.getTime() + 2 * 86_400_000))).toBe(0);
    });

    it('drafted stores the refined sha and clears the error; it does not overwrite an item edited meanwhile', async () => {
        const item = await add(p1, r1, 1, { lastError: 'old' });
        await service.begin(item);
        expect(await service.drafted(item.id, 'sha-1')).toBe(true);
        expect(await items.findOneByOrFail({ id: item.id })).toMatchObject({ status: 'drafted', refinedSha256: 'sha-1', lastError: null });

        const edited = await add(p1, r1, 2);
        await service.begin(edited);
        await items.update({ id: edited.id }, { status: 'new' }); // applyIssue put it back after an edit
        expect(await service.drafted(edited.id, 'sha-2')).toBe(false);
        expect(await items.findOneByOrFail({ id: edited.id })).toMatchObject({ status: 'new', refinedSha256: null });
    });

    it(`goes back to new after a failed attempt and to failed after ${MAX_REFINE_ATTEMPTS}, with a short single-line error`, async () => {
        const item = await add(p1, r1, 1);
        await service.begin(item);
        expect(await service.failed(item.id, 'first\nproblem')).toBe('new');
        expect(await items.findOneByOrFail({ id: item.id })).toMatchObject({ status: 'new', lastError: 'first problem' });

        const again = await service.begin(await items.findOneByOrFail({ id: item.id }));
        expect(again?.refineAttempts).toBe(2);
        expect(await service.failed(item.id, 'x'.repeat(2000))).toBe('failed');
        const failed = await items.findOneByOrFail({ id: item.id });
        expect(failed.status).toBe('failed');
        expect(failed.lastError).toHaveLength(500);
        expect(await service.nextPerProject()).toEqual([]);
    });

    it('failed leaves an item that is not refining alone', async () => {
        const item = await add(p1, r1, 1, { status: 'withdrawn' });
        expect(await service.failed(item.id, 'x')).toBeNull();
        expect((await items.findOneByOrFail({ id: item.id })).status).toBe('withdrawn');
    });

    it('links a spec only to an item that has none', async () => {
        const item = await add(p1, r1, 1);
        const first = '66666666-6666-4666-8666-666666666666';
        expect(await service.linkSpec(item.id, first)).toBe(true);
        expect(await service.linkSpec(item.id, '77777777-7777-4777-8777-777777777777')).toBe(false);
        expect((await items.findOneByOrFail({ id: item.id })).specId).toBe(first);
    });
});
