import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from './../src/app.module.js';
import { BUDGET_CLOCK } from './../src/budget/budget.service.js';
import { AgentUsage } from './../src/otel/agent-usage.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { LlmUsage } from './../src/usage/usage.entity.js';
import { authedAgent } from './helpers/auth.js';

const DAILY = 'GLOBAL_DAILY_BUDGET_USD';
const WEEKLY = 'GLOBAL_WEEKLY_BUDGET_USD';

describe('Budget (e2e)', () => {
  let app: INestApplication<App>;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let now = new Date('2026-03-10T12:00:00Z');

  const boot = async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BUDGET_CLOCK).useValue(() => now)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  };

  beforeEach(async () => {
    delete process.env[DAILY];
    delete process.env[WEEKLY];
    now = new Date('2026-03-10T12:00:00Z');
    await boot();
    // The e2e database is shared and persistent: start every test without usage so the sums are exact.
    await app.get(DataSource).getRepository(AgentUsage).clear();
    await app.get(DataSource).getRepository(LlmUsage).clear();
  });

  afterEach(async () => {
    delete process.env[DAILY];
    delete process.env[WEEKLY];
    vi.restoreAllMocks();
    await app.close();
  });

  const makeProject = async (extra: Record<string, unknown> = {}) => {
    const slug = `bg-${randomUUID().slice(0, 8)}`;
    const project = (await http.post('/api/v1/projects').send({ slug, name: 'BG', ...extra }).expect(201)).body;
    const repo = (await http.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
    const job = (await http.post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Budget job', task: 'Do the thing please' }).expect(201)).body;
    const run = await app.get(DataSource).getRepository(JobRun).save({ jobId: job.id, projectId: project.id, repoId: repo.id, attempt: 1 });
    return { project, run };
  };
  const agent = (runId: string | null, costUsd: number | null, eventAt = '2026-03-10T01:00:00Z') =>
    app.get(DataSource).getRepository(AgentUsage).insert({
      id: randomUUID(), runId, sessionId: 's', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, eventAt: new Date(eventAt), eventKey: randomUUID(),
    });

  it('requires ordinary authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/budget').expect(401);
    await request(app.getHttpServer()).get('/api/v1/budget').set('Authorization', 'Bearer otel-ingest-secret-0123456789-abcdefghij').expect(401);
  });

  it('returns global status without a project and validates the query', async () => {
    const res = await http.get('/api/v1/budget').expect(200);
    expect(res.body).toMatchObject({ evaluatedAt: now.toISOString(), project: null, blockers: [], hardBlocked: false, recovery: 'none' });
    expect(res.body.global.day).toMatchObject({ state: 'ok', limit: null, percent: null, spent: 0, pricing: 'empty' });
    await http.get('/api/v1/budget?projectId=nope').expect(400);
    await http.get('/api/v1/budget?projectId=').expect(400);
    await http.get(`/api/v1/budget?projectId=${randomUUID()}`).expect(404);
  });

  it('is read-only: only GET exists', async () => {
    await http.post('/api/v1/budget').send({}).expect(404);
    await http.patch('/api/v1/budget').send({}).expect(404);
    await http.delete('/api/v1/budget').expect(404);
  });

  it('roundtrips project settings and reports the project and global periods', async () => {
    const { project, run } = await makeProject({ dailyBudgetUsd: 10, budgetSoftPct: 50 });
    expect(project).toMatchObject({ dailyBudgetUsd: 10, weeklyBudgetUsd: null, budgetSoftPct: 50 });
    await agent(run.id, 6);
    await agent(null, 1);
    await app.get(DataSource).getRepository(LlmUsage).insert({ kind: 'embedding', model: 'm', costUsd: 2, createdAt: new Date('2026-03-10T02:00:00Z') });
    const res = await http.get(`/api/v1/budget?projectId=${project.id}`).expect(200);
    expect(res.body.project.day).toMatchObject({ spent: 6, limit: 10, percent: 60, state: 'soft', softPct: 50 });
    expect(res.body.project.week).toMatchObject({ limit: null, state: 'ok', spent: 6 });
    expect(res.body.global.day).toMatchObject({ spent: 9, totalRows: 3 });
    expect(res.body.hardBlocked).toBe(false);
  });

  it('PATCH clears with null, preserves when omitted and rejects invalid limits', async () => {
    const { project } = await makeProject({ dailyBudgetUsd: 10, weeklyBudgetUsd: 0 });
    const url = `/api/v1/projects/${project.id}`;
    expect((await http.patch(url).send({ name: 'X' }).expect(200)).body).toMatchObject({ dailyBudgetUsd: 10, weeklyBudgetUsd: 0 });
    expect((await http.patch(url).send({ dailyBudgetUsd: null }).expect(200)).body).toMatchObject({ dailyBudgetUsd: null, weeklyBudgetUsd: 0 });
    expect((await http.get(url).expect(200)).body).toMatchObject({ dailyBudgetUsd: null, weeklyBudgetUsd: 0, budgetSoftPct: 80 });
    expect((await http.get('/api/v1/projects').expect(200)).body.find((p: { id: string }) => p.id === project.id)).toMatchObject({ weeklyBudgetUsd: 0 });
    for (const bad of [{ dailyBudgetUsd: -1 }, { dailyBudgetUsd: 'abc' }, { budgetSoftPct: 0 }, { budgetSoftPct: 101 }, { budgetSoftPct: null }]) {
      await http.patch(url).send(bad).expect(400);
    }
    await http.post('/api/v1/projects').send({ slug: 'bad-limit', name: 'B', weeklyBudgetUsd: -5 }).expect(400);
  });

  it('uses the controllable clock for UTC midnight and Monday rollovers', async () => {
    process.env[DAILY] = '5';
    await app.get(DataSource).getRepository(LlmUsage).insert({ kind: 'chat', model: 'm', costUsd: 5, createdAt: new Date('2026-03-10T23:00:00Z') });
    now = new Date('2026-03-10T23:59:59.999Z');
    expect((await http.get('/api/v1/budget').expect(200)).body.global.day).toMatchObject({ state: 'hard', resetsAt: '2026-03-11T00:00:00.000Z' });
    now = new Date('2026-03-11T00:00:00Z');
    const res = (await http.get('/api/v1/budget').expect(200)).body;
    expect(res.global.day).toMatchObject({ state: 'ok', spent: 0 });
    expect(res.global.week).toMatchObject({ spent: 5, startsAt: '2026-03-09T00:00:00.000Z' });
  });

  it('hard global with a fine project: blockers, reset and recovery', async () => {
    process.env[WEEKLY] = '1';
    const { project } = await makeProject({ dailyBudgetUsd: 100 });
    await agent(null, 3);
    const res = (await http.get(`/api/v1/budget?projectId=${project.id}`).expect(200)).body;
    expect(res.project.day.state).toBe('ok');
    expect(res.blockers).toEqual([expect.objectContaining({ scope: 'global', period: 'week', kind: 'limit' })]);
    expect(res).toMatchObject({ hardBlocked: true, recovery: 'reset', recoversAt: '2026-03-16T00:00:00.000Z' });
  });

  describe('invalid global configuration', () => {
    const SECRET = 'not-a-number-SECRET';

    it('lets the API start, logs the variable only, and reports configError', async () => {
      await app.close();
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      process.env[DAILY] = SECRET;
      process.env[WEEKLY] = '50';
      await boot();
      await app.get(DataSource).getRepository(AgentUsage).clear();
      await app.get(DataSource).getRepository(LlmUsage).clear();
      const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(DAILY);
      expect(logged).not.toContain(SECRET);
      await http.get('/api/health').expect(200);

      const { project } = await makeProject();
      await agent(null, 2);
      const res = (await http.get(`/api/v1/budget?projectId=${project.id}`).expect(200)).body;
      expect(JSON.stringify(res)).not.toContain(SECRET);
      expect(res.global.day).toMatchObject({ state: 'hard', limit: null, percent: null, spent: 2, reason: { kind: 'configError', variable: DAILY } });
      expect(res.global.week).toMatchObject({ state: 'ok', limit: 50 });
      expect(res.project.day.state).toBe('ok');
      expect(res.blockers).toEqual([expect.objectContaining({ scope: 'global', period: 'day', kind: 'configError', variable: DAILY })]);
      expect(res).toMatchObject({ hardBlocked: true, recovery: 'manual', recoversAt: null });

      // A period reset does not fix it.
      now = new Date('2026-03-11T00:00:00Z');
      expect((await http.get('/api/v1/budget').expect(200)).body.global.day.state).toBe('hard');

      // Correcting the value recovers on the next evaluation, without a restart.
      process.env[DAILY] = '10';
      const fixed = (await http.get('/api/v1/budget').expect(200)).body;
      expect(fixed.global.day).toMatchObject({ state: 'ok', limit: 10, reason: null });
      expect(fixed.hardBlocked).toBe(false);
    });

    it('handles both variables invalid next to a project limit blocker', async () => {
      process.env[DAILY] = 'x';
      process.env[WEEKLY] = '-1';
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { project, run } = await makeProject({ weeklyBudgetUsd: 1 });
      await agent(run.id, 2);
      const res = (await http.get(`/api/v1/budget?projectId=${project.id}`).expect(200)).body;
      expect(res.blockers.map((b: { scope: string; period: string; kind: string }) => `${b.scope}/${b.period}/${b.kind}`))
        .toEqual(['global/day/configError', 'global/week/configError', 'project/week/limit']);
      expect(res.recovery).toBe('manual');
      // Human API use is not blocked.
      await http.get('/api/v1/projects').expect(200);
    });
  });
});
