import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';

import { BudgetService } from './../src/budget/budget.service.js';
import { AppModule } from './../src/app.module.js';
import { PlanningWorker } from './../src/copilot/planning.worker.js';
import { planConfig } from './../src/copilot/werkmeester.config.js';
import { WerkmeesterService } from './../src/copilot/werkmeester.service.js';
import { Feature } from './../src/feature/feature.entity.js';
import { NotificationCaptureService } from './../src/notification/notification-capture.service.js';
import { Notification } from './../src/notification/notification.entity.js';
import { SpecPlanningRun } from './../src/spec/spec-planning-run.entity.js';
import { SpecPlanningService } from './../src/spec/spec-planning.service.js';
import { createApiKey, createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

const body = [
  '## Goal\n\nShip it.', '## Context\n\nWhy.', '## Behaviour\n\nHow.',
  '## Acceptance criteria\n\n- AC-1: First\n- AC-2: Second', '## Out of scope\n\nNothing.', '## Open questions\n\nNone',
].join('\n\n') + '\n';

describe('Werkmeester planning runs (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let projectId: string;
  let repoId: string;
  const fake = { bind: vi.fn(), plan: vi.fn() };
  const as = (u: TestUser) => request.agent(app.getHttpServer()).set({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const runs = () => app.get<Repository<SpecPlanningRun>>(getRepositoryToken(SpecPlanningRun));
  const notifications = () => app.get<Repository<Notification>>(getRepositoryToken(Notification));
  const features = () => app.get<Repository<Feature>>(getRepositoryToken(Feature));

  beforeEach(async () => {
    vi.resetAllMocks();
    fake.bind.mockImplementation((t: object) => ({ ...t, issued: true }));
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WerkmeesterService).useValue(fake).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.listen(0);
    await runs().createQueryBuilder().delete().execute(); // the e2e database is shared: only this test's runs
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = `pl-${randomUUID().slice(0, 8)}`;
    projectId = (await as(ann).post('/api/v1/projects').send({ slug, name: 'Planning project' }).expect(201)).body.id;
    repoId = (await as(ann).post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body.id;
  });

  afterEach(async () => {
    await app.close();
  });

  const setAutoPlan = async (autoPlan: boolean) => {
    const p = (await as(ann).get(`/api/v1/projects/${projectId}`).expect(200)).body;
    const { id: _id, slug: _slug, paused: _paused, createdAt: _c, updatedAt: _u, ...settings } = p;
    await as(ann).put(`/api/v1/projects/${projectId}`).send({ ...settings, autoPlan }).expect(200);
  };
  const createSpec = async () =>
    (await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: `s-${randomUUID().slice(0, 8)}`, title: 'A spec', body, expectedVersion: 0 }).expect(201)).body;
  const approve = (id: string, expectedVersion: number) => as(ann).post(`/api/v1/specs/${id}/approve`).send({ expectedVersion });
  const saveVersion = (id: string, expectedVersion: number) =>
    as(ann).post(`/api/v1/specs/${id}/versions`).send({ title: 'A spec', body, expectedVersion }).expect(201);
  const detail = async (id: string) => (await as(ann).get(`/api/v1/specs/${id}`).expect(200)).body;
  const plan = (id: string, u: TestUser = ann) => as(u).post(`/api/v1/specs/${id}/plan`);
  const pin = (specId: string, specVersion: number, title = 'Planned feature') =>
    features().save(features().create({ projectId, title, spec: '', specId, specVersion } as never));
  const worker = (dailyLimit = '5') => {
    const config = planConfig({ PLAN_ENABLED: 'true', PLAN_USER_EMAIL: 'w@example.com', PLAN_MODEL: 'openai/m', OPENAI_API_KEY: 'k', PLAN_DAILY_LIMIT: dailyLimit });
    if (!config.enabled) throw new Error('test setup');
    return new PlanningWorker({ config, user: { id: randomUUID(), name: 'W', email: 'w@example.com' } } as never, fake as never, app.get(SpecPlanningService), app.get(BudgetService), app.get(NotificationCaptureService));
  };

  describe('autoPlan', () => {
    it('is off by default and queues nothing on approval', async () => {
      expect((await as(ann).get(`/api/v1/projects/${projectId}`).expect(200)).body.autoPlan).toBe(false);
      const spec = await createSpec();
      await approve(spec.id, 1).expect(200);
      expect(await runs().count()).toBe(0);
      expect((await detail(spec.id)).versions[0].planning).toBeNull();
    });

    it('queues exactly one auto run for an approved version, and repeating the approval adds none', async () => {
      await setAutoPlan(true);
      const spec = await createSpec();
      const res = await approve(spec.id, 1).expect(200);
      await approve(spec.id, 1).expect(200);
      const rows = await runs().find({ where: { specId: spec.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, projectId, status: 'queued', attempts: 0, trigger: 'auto', requestedById: null });
      expect(res.body.versions[0].planning).toMatchObject({ id: rows[0].id, status: 'queued', trigger: 'auto', featureId: null });
    });

    it('queues exactly one run under concurrent approvals', async () => {
      await setAutoPlan(true);
      const spec = await createSpec();
      await Promise.all(Array.from({ length: 5 }, () => approve(spec.id, 1)));
      expect(await runs().countBy({ specId: spec.id })).toBe(1);
    });

    it('queues a run per approved version once the earlier one is final', async () => {
      await setAutoPlan(true);
      const spec = await createSpec();
      await approve(spec.id, 1).expect(200);
      await saveVersion(spec.id, 1);
      await approve(spec.id, 2).expect(200);
      expect((await runs().find({ where: { specId: spec.id }, order: { version: 'ASC' } })).map((r) => r.version)).toEqual([1, 2]);
      expect((await detail(spec.id)).versions.map((v: { version: number; planning: unknown }) => [v.version, !!v.planning])).toEqual([[2, true], [1, true]]);
    });

    it('records a note instead of a run when an earlier version already has a feature', async () => {
      await setAutoPlan(true);
      const spec = await createSpec();
      await approve(spec.id, 1).expect(200);
      await runs().delete({ specId: spec.id });
      await pin(spec.id, 1, 'Export feature');
      await saveVersion(spec.id, 1);
      const res = await approve(spec.id, 2).expect(200);
      expect(await runs().countBy({ specId: spec.id })).toBe(0);
      expect(res.body.planNote).toBe('v2 approved; feature Export feature is pinned to v1');
      expect((await as(ann).get(`/api/v1/projects/${projectId}/specs`).expect(200)).body[0].planNote).toBe(res.body.planNote);
    });

    it('queues nothing for a version that already has its feature', async () => {
      await setAutoPlan(true);
      const spec = await createSpec();
      await pin(spec.id, 1);
      await approve(spec.id, 1).expect(200);
      expect(await runs().countBy({ specId: spec.id })).toBe(0);
    });

    it('is stored and replaced through the project PUT', async () => {
      await setAutoPlan(true);
      expect((await as(ann).get(`/api/v1/projects/${projectId}`).expect(200)).body.autoPlan).toBe(true);
      const p = (await as(ann).get(`/api/v1/projects/${projectId}`).expect(200)).body;
      const { id: _id, slug: _slug, paused: _paused, createdAt: _c, updatedAt: _u, autoPlan: _a, ...without } = p;
      await as(ann).put(`/api/v1/projects/${projectId}`).send(without).expect(400);
    });
  });

  describe('POST /api/v1/specs/:id/plan', () => {
    it('queues a manual run for the approved version even with autoPlan off', async () => {
      const spec = await createSpec();
      await approve(spec.id, 1).expect(200);
      const res = await plan(spec.id).expect(200);
      expect(res.body.versions[0].planning).toMatchObject({ status: 'queued', trigger: 'manual', requestedById: ann.id, version: 1 });
      expect(await runs().countBy({ specId: spec.id })).toBe(1);
    });

    it('answers 409 when there is no approved version, the spec is archived, or it is queued already', async () => {
      const spec = await createSpec();
      expect((await plan(spec.id).expect(409)).body.message).toMatch(/no approved version/);
      await approve(spec.id, 1).expect(200);
      await plan(spec.id).expect(200);
      expect((await plan(spec.id).expect(409)).body.message).toMatch(/already has a planning run that is queued/);
      await runs().update({ specId: spec.id }, { status: 'running' });
      expect((await plan(spec.id).expect(409)).body.message).toMatch(/running/);
      await runs().update({ specId: spec.id }, { status: 'failed' });
      await as(ann).post(`/api/v1/specs/${spec.id}/archive`).expect(200);
      expect((await plan(spec.id).expect(409)).body.message).toMatch(/archived/);
      await as(ann).post(`/api/v1/specs/${spec.id}/unarchive`).expect(200);
      await plan(spec.id).expect(200); // a failed run can be requested again
    });

    it('answers 409 when the version already has a feature', async () => {
      const spec = await createSpec();
      await approve(spec.id, 1).expect(200);
      await pin(spec.id, 1, 'Done already');
      expect((await plan(spec.id).expect(409)).body.message).toMatch(/already planned.*Done already/);
      expect(await runs().countBy({ specId: spec.id })).toBe(0);
    });

    it('is for verified humans only, and unknown specs are 404', async () => {
      const spec = await createSpec();
      await approve(spec.id, 1).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/specs/${spec.id}/plan`).expect(401);
      const key = await createApiKey(app, ann);
      await request(app.getHttpServer()).post(`/api/v1/specs/${spec.id}/plan`).set({ Authorization: `Bearer ${key}` }).expect(401);
      await plan(randomUUID()).expect(404);
      expect(await runs().countBy({ specId: spec.id })).toBe(0);
    });
  });

  describe('the worker', () => {
    const queue = async () => {
      const spec = await createSpec();
      await approve(spec.id, 1).expect(200);
      await plan(spec.id).expect(200);
      return spec;
    };

    it('plans a queued run and stores the feature on the version', async () => {
      const spec = await queue();
      const planned = await features().save(features().create({ projectId, title: 'New feature', spec: '' } as never));
      fake.plan.mockResolvedValue({ outcome: 'planned', featureId: planned.id });
      expect(await worker().tick()).toHaveLength(1);
      expect(fake.bind).toHaveBeenCalledWith(expect.objectContaining({ projectId, specId: spec.id, version: 1 }), 1);
      expect((await detail(spec.id)).versions[0].planning).toMatchObject({ status: 'planned', attempts: 1, featureId: planned.id });
    });

    it('sends spec.planned through the outbox once the run is planned', async () => {
      const spec = await queue();
      const planned = await features().save(features().create({ projectId, title: 'New feature', spec: '' } as never));
      fake.plan.mockResolvedValue({ outcome: 'planned', featureId: planned.id });
      await worker().tick();
      const run = await runs().findOneByOrFail({ specId: spec.id });
      expect(await notifications().findOneByOrFail({ occurrenceKey: `spec.planned:${run.id}` })).toMatchObject({
        kind: 'spec.planned', projectId, featureId: planned.id, title: 'New feature', status: 'pending',
      });
    });

    it('sends spec.plan_failed only when the last attempt failed, with the short reason', async () => {
      const spec = await queue();
      fake.plan.mockResolvedValue({ outcome: 'failed', reason: 'No plan, Bearer abc123secret' });
      await worker().tick();
      const run = await runs().findOneByOrFail({ specId: spec.id });
      expect(await notifications().countBy({ occurrenceKey: `spec.plan_failed:${run.id}` })).toBe(0);
      await worker().tick();
      const sent = await notifications().findOneByOrFail({ occurrenceKey: `spec.plan_failed:${run.id}` });
      expect(sent).toMatchObject({ kind: 'spec.plan_failed', projectId, title: 'A spec v1' });
      expect(sent.reason).toContain('No plan');
      expect(sent.reason).not.toContain('abc123secret');
    });

    it('skips a version that got a feature while queued, without calling the agent', async () => {
      const spec = await queue();
      await pin(spec.id, 1, 'Pinned meanwhile');
      await worker().tick();
      expect(fake.plan).not.toHaveBeenCalled();
      expect((await detail(spec.id)).versions[0].planning).toMatchObject({ status: 'skipped', reason: expect.stringContaining('Pinned meanwhile') });
    });

    it('retries once and then fails with the reason', async () => {
      const spec = await queue();
      fake.plan.mockResolvedValue({ outcome: 'failed', reason: 'The agent finished without proposing a plan' });
      await worker().tick();
      expect((await detail(spec.id)).versions[0].planning).toMatchObject({ status: 'queued', attempts: 1 });
      await worker().tick();
      expect((await detail(spec.id)).versions[0].planning).toMatchObject({ status: 'failed', attempts: 2, reason: 'The agent finished without proposing a plan' });
      await worker().tick();
      expect(fake.plan).toHaveBeenCalledTimes(2);
    });

    it('records a skipped outcome from the agent', async () => {
      const spec = await queue();
      fake.plan.mockResolvedValue({ outcome: 'skipped', reason: 'archived' });
      await worker().tick();
      expect((await detail(spec.id)).versions[0].planning).toMatchObject({ status: 'skipped', reason: 'archived' });
    });

    it('does not run past the daily limit of the project', async () => {
      const first = await queue();
      fake.plan.mockResolvedValue({ outcome: 'failed', reason: 'x' });
      expect(await worker('1').tick()).toHaveLength(1);
      expect(await worker('1').tick()).toHaveLength(0);
      expect((await detail(first.id)).versions[0].planning).toMatchObject({ status: 'queued', attempts: 1 });
    });

    it('does not run while the project budget is hard', async () => {
      const spec = await queue();
      const p = (await as(ann).get(`/api/v1/projects/${projectId}`).expect(200)).body;
      const { id: _id, slug: _slug, paused: _paused, createdAt: _c, updatedAt: _u, ...settings } = p;
      await as(ann).put(`/api/v1/projects/${projectId}`).send({ ...settings, dailyBudgetUsd: 0 }).expect(200);
      expect(await worker().tick()).toHaveLength(0);
      expect(fake.plan).not.toHaveBeenCalled();
      expect((await detail(spec.id)).versions[0].planning).toMatchObject({ status: 'queued', attempts: 0 });
    });
  });
});
