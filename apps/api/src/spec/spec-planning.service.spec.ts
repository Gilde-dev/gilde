import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { Feature } from '../feature/feature.entity.js';
import { SpecPlanningRun } from './spec-planning-run.entity.js';
import { MAX_PLAN_ATTEMPTS, SpecPlanningService } from './spec-planning.service.js';

let ds: DataSource;
let runs: Repository<SpecPlanningRun>;
let service: SpecPlanningService;

const P1 = randomUUID();
const P2 = randomUUID();

const add = (over: Partial<SpecPlanningRun> = {}) =>
    runs.save(runs.create({ specId: randomUUID(), version: 1, approvalId: randomUUID(), projectId: P1, status: 'queued', attempts: 0, trigger: 'auto', ...over }));

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', synchronize: true, entities: [SpecPlanningRun, Feature] }).initialize();
    runs = ds.getRepository(SpecPlanningRun);
    service = new SpecPlanningService(runs, ds.getRepository(Feature));
});
afterEach(() => ds.destroy());

describe('spec_planning_runs', () => {
    it('allows one open run per spec version, and a new one once it is final', async () => {
        const first = await add();
        await expect(add({ specId: first.specId, version: 1 })).rejects.toThrow(/UNIQUE/i);
        await add({ specId: first.specId, version: 2 }); // another version is fine
        await runs.update({ id: first.id }, { status: 'running' });
        await expect(add({ specId: first.specId, version: 1 })).rejects.toThrow(/UNIQUE/i);
        await runs.update({ id: first.id }, { status: 'failed' });
        await add({ specId: first.specId, version: 1 });
        expect(await runs.countBy({ specId: first.specId, version: 1 })).toBe(2);
    });
});

describe('SpecPlanningService', () => {
    it('picks the oldest queued run per project and none for a project that has a run running', async () => {
        const oldest = await add({ createdAt: new Date(2026, 0, 1) });
        await add({ createdAt: new Date(2026, 0, 2) });
        const other = await add({ projectId: P2, createdAt: new Date(2026, 0, 3) });
        expect((await service.nextPerProject()).map((r) => r.id).sort()).toEqual([oldest.id, other.id].sort());
        await runs.update({ id: oldest.id }, { status: 'running' });
        expect((await service.nextPerProject()).map((r) => r.id)).toEqual([other.id]);
    });

    it('claims a queued run once, counts the attempt and the daily start', async () => {
        const run = await add();
        const now = new Date(Date.UTC(2026, 5, 10, 12));
        expect(await service.runsToday(P1, now)).toBe(0);
        const began = await service.begin(run, now);
        expect(began).toMatchObject({ status: 'running', attempts: 1 });
        expect(await service.begin(run, now)).toBeNull();
        expect(await service.runsToday(P1, now)).toBe(1);
        expect(await service.runsToday(P2, now)).toBe(0);
        expect(await service.runsToday(P1, new Date(Date.UTC(2026, 5, 11, 0, 0, 1)))).toBe(0);
    });

    it('requeues a failed attempt and fails the run after the last one', async () => {
        const run = await add();
        await service.begin(run);
        expect(await service.failed(run.id, '  no   plan\nproposed ')).toBe('queued');
        expect(await runs.findOneBy({ id: run.id })).toMatchObject({ status: 'queued', reason: 'no plan proposed' });
        for (let i = 1; i < MAX_PLAN_ATTEMPTS; i++) {
            await service.begin((await runs.findOneBy({ id: run.id }))!);
        }
        expect(await service.failed(run.id, 'still nothing')).toBe('failed');
        expect(await runs.findOneBy({ id: run.id })).toMatchObject({ status: 'failed', attempts: MAX_PLAN_ATTEMPTS });
        expect(await service.failed(run.id, 'again')).toBeNull(); // final runs do not change
    });

    it('ends as planned or skipped only from running', async () => {
        const run = await add();
        expect(await service.planned(run.id, randomUUID())).toBe(false);
        await service.begin(run);
        const featureId = randomUUID();
        expect(await service.planned(run.id, featureId)).toBe(true);
        expect(await runs.findOneBy({ id: run.id })).toMatchObject({ status: 'planned', featureId });
        expect(await service.skipped(run.id, 'late')).toBe(false);
        const other = await add();
        await service.begin(other);
        expect(await service.skipped(other.id, 'archived')).toBe(true);
        expect(await runs.findOneBy({ id: other.id })).toMatchObject({ status: 'skipped', reason: 'archived' });
    });

    it('treats a run abandoned by a dead process as a failed attempt', async () => {
        const run = await add();
        await service.begin(run, new Date());
        expect(await service.recoverStale(new Date())).toBe(0);
        expect(await service.recoverStale(new Date(Date.now() + 20 * 60_000))).toBe(1);
        expect(await runs.findOneBy({ id: run.id })).toMatchObject({ status: 'queued', reason: expect.stringContaining('did not finish') });
    });

    it('finds the feature pinned to a version', async () => {
        const specId = randomUUID();
        const features = ds.getRepository(Feature);
        const feature = await features.save(features.create({ projectId: P1, title: 'Planned', spec: '', specId, specVersion: 2 } as never));
        expect(await service.pinnedFeature(specId, 2)).toMatchObject({ id: feature.id, title: 'Planned' });
        expect(await service.pinnedFeature(specId, 3)).toBeNull();
    });
});
