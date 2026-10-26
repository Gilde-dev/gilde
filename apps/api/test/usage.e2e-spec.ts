import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { UsageService } from './../src/usage/usage.service.js';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AgentUsage } from './../src/otel/agent-usage.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { authedAgent } from './helpers/auth.js';

describe('Usage (e2e)', () => {
  let app: INestApplication<App>;
  let http: Awaited<ReturnType<typeof authedAgent>>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1/usage returns totals, a daily series and breakdowns', async () => {
    await app.get(UsageService).record({ kind: 'chat', model: 'openai/e2e-model', inputTokens: 10, outputTokens: 5 });
    const res = await http.get('/api/v1/usage?days=7').expect(200);
    expect(res.body.days).toBe(7);
    expect(res.body.totals.totalTokens).toBeGreaterThanOrEqual(15);
    expect(res.body.daily).toHaveLength(7);
    expect(res.body.byModel.some((m: { model: string }) => m.model === 'openai/e2e-model')).toBe(true);
    expect(res.body).toHaveProperty('byKind');
    expect(res.body).toHaveProperty('byUser');
    await http.get('/api/v1/usage?kind=nope').expect(400);
  });

  describe('agents', () => {
    it('validates the query and returns an empty, zero-filled response for an unknown project', async () => {
      await http.get('/api/v1/usage/agents?days=0').expect(400);
      await http.get('/api/v1/usage/agents?days=366').expect(400);
      await http.get('/api/v1/usage/agents?projectId=nope').expect(400);
      const res = await http.get(`/api/v1/usage/agents?days=3&projectId=${randomUUID()}`).expect(200);
      expect(res.body).toMatchObject({ days: 3, scope: 'project', totals: { runs: 0, totalTokens: 0, costUsd: null }, byModel: [], byRepo: [], byFeature: [], unattributed: { runs: 0 } });
      expect(res.body.daily).toHaveLength(3);
      expect((await http.get('/api/v1/usage/agents').expect(200)).body).toMatchObject({ days: 30, scope: 'global', projectId: null });
    });

    it('requires ordinary authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/usage/agents').expect(401);
      await request(app.getHttpServer()).get('/api/v1/usage/agents').set('Authorization', 'Bearer otel-ingest-secret-0123456789-abcdefghij').expect(401);
    });

    it('adds lifetime agent totals to job and feature detail and scopes project usage', async () => {
      const slug = `ag-${randomUUID().slice(0, 8)}`;
      const project = (await http.post('/api/v1/projects').send({ slug, name: 'AG' }).expect(201)).body;
      const repo = (await http.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
      const feature = (await http.post(`/api/v1/projects/${project.id}/features`).send({ title: 'Feat', spec: 'Spec text here' }).expect(201)).body;
      const job = (await http.post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Agent job', task: 'Do the thing please', featureId: feature.id }).expect(201)).body;
      const empty = (await http.get(`/api/v1/jobs/${job.id}`).expect(200)).body;
      expect(empty.runs).toEqual([]);
      expect(empty.agentUsage).toMatchObject({ runs: 0, totalTokens: 0, costUsd: null });
      expect((await http.get(`/api/v1/features/${feature.id}`).expect(200)).body.agentUsage).toMatchObject({ runs: 0, costUsd: null });

      const ds = app.get(DataSource);
      const run = async (attempt: number) => ds.getRepository(JobRun).save(ds.getRepository(JobRun).create({ jobId: job.id, projectId: project.id, repoId: repo.id, attempt }));
      const [r1, r2] = [await run(1), await run(2)];
      const row = (runId: string | null, cost: number | null) => ds.getRepository(AgentUsage).insert({
        id: randomUUID(), runId, jobId: runId ? job.id : null, attribution: runId ? 'session' : null, sessionId: 's', model: 'claude-x',
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20, costUsd: cost, eventAt: new Date(), eventKey: randomUUID(),
      });
      await row(r1.id, 0.5); await row(r1.id, null); await row(r2.id, 0); await row(null, 9);

      const detail = (await http.get(`/api/v1/jobs/${job.id}`).expect(200)).body;
      expect(detail.runs.map((r: { attempt: number }) => r.attempt)).toEqual([1, 2]);
      expect(detail.runs[0].agentUsage).toMatchObject({ runs: 2, totalTokens: 270, costUsd: 0.5, costPartial: true, cacheCreationTokens: 40 });
      expect(detail.runs[1].agentUsage).toMatchObject({ runs: 1, costUsd: 0, costPartial: false });
      expect(detail.agentUsage).toMatchObject({ runs: 3, totalTokens: 405, costUsd: 0.5 });
      expect((await http.get(`/api/v1/features/${feature.id}`).expect(200)).body.agentUsage).toMatchObject({ runs: 3, totalTokens: 405 });

      const scoped = (await http.get(`/api/v1/usage/agents?projectId=${project.id}`).expect(200)).body;
      expect(scoped).toMatchObject({ scope: 'project', totals: { runs: 3 }, unattributed: { runs: 0 } });
      expect(scoped.byFeature[0]).toMatchObject({ featureId: feature.id, title: 'Feat', runs: 3 });
      expect(scoped.byRepo[0]).toMatchObject({ repoId: repo.id, fullName: `o/${slug}` });
      expect((await http.get('/api/v1/usage/agents').expect(200)).body.unattributed.runs).toBeGreaterThanOrEqual(1);
      await http.get('/api/v1/jobs/' + randomUUID()).expect(404);
    });
  });
});
