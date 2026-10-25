import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { Feedback } from './../src/feedback/feedback.entity.js';
import { Job } from './../src/job/job.entity.js';
import { Lesson } from './../src/lesson/lesson.entity.js';
import { HISTORY_OPTIONS, historyOptions } from './../src/memory/history/history.types.js';
import { MEMORY_INFRASTRUCTURE } from './../src/memory/memory.tokens.js';
import { testMemoryInfrastructure } from './../src/memory/memory.testing.js';
import { Project } from './../src/project/project.entity.js';
import { Repo } from './../src/repo/repo.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { createTestUser, tokenFor } from './helpers/auth.js';

describe('History (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  let headers: { Authorization: string };
  let project: Project;
  let repo: Repo;
  let otherRepo: Repo;
  let job: Job;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-history-'));
    const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'history.db')}`, dimension: 64 });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MEMORY_INFRASTRUCTURE).useValue(infra)
      .overrideProvider(HISTORY_OPTIONS).useValue({ ...historyOptions({}), freshnessMs: 1, retryDelayMs: 0, embedAttempts: 1 })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    headers = { Authorization: `Bearer ${tokenFor(app, await createTestUser(app))}` };

    const ds = app.get(DataSource);
    const tag = randomUUID().slice(0, 8);
    project = await ds.getRepository(Project).save({ slug: `hist-${tag}`, name: 'History project' });
    repo = await ds.getRepository(Repo).save({ projectId: project.id, fullName: `acme/hist-web-${tag}` });
    const foreign = await ds.getRepository(Project).save({ slug: `hist-foreign-${tag}`, name: 'Foreign' });
    otherRepo = await ds.getRepository(Repo).save({ projectId: foreign.id, fullName: `acme/hist-foreign-${tag}` });
    job = await ds.getRepository(Job).save({ projectId: project.id, repoId: repo.id, title: 'Add xylophone export', task: 'Export xylophone data', acceptanceCriteria: [], status: 'merged', prNumber: 3, prUrl: 'https://github.com/acme/web/pull/3' });
    await ds.getRepository(JobRun).save({ jobId: job.id, projectId: project.id, repoId: repo.id, attempt: 1, status: 'ci_passed', result: { outcome: 'done', summary: 'xylophone export streams' }, retro: 'Streaming the xylophone export fixed the memory spike' });
    await ds.getRepository(Lesson).save({ projectId: project.id, text: 'Stream xylophone exports', status: 'approved' });
    await ds.getRepository(Lesson).save({ projectId: project.id, text: 'Candidate xylophone idea', status: 'candidate' });
    await ds.getRepository(Feedback).save({ jobId: job.id, projectId: project.id, repoId: repo.id, prNumber: 3, kind: 'review', githubId: tag, author: 'rev', authorAssociation: 'MEMBER', state: 'approved', body: 'xylophone export looks good', url: 'https://github.com/acme/web/pull/3#pullrequestreview-9' });
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([['GET', '/api/v1/history/status'], ['POST', '/api/v1/history/search'], ['POST', '/api/v1/history/reconcile'], ['POST', '/api/v1/history/rebuild']])('%s %s is 401 without a token', async (method, path) => {
    await http()[method.toLowerCase() as 'get' | 'post'](path).expect(401);
  });

  it('rebuilds the index from the sources, in bounded runs, and reports status', async () => {
    let outcome = (await http().post('/api/v1/history/rebuild').set(headers).expect(200)).body.outcome;
    for (let i = 0; i < 50 && outcome !== 'complete'; i++) outcome = (await http().post('/api/v1/history/reconcile').set(headers).expect(200)).body.outcome;
    expect(outcome).toBe('complete');
    const status = (await http().get('/api/v1/history/status').set(headers).expect(200)).body;
    expect(status).toMatchObject({ enabled: true, embeddings: true, passInProgress: false, lastError: null });
    expect(status.indexedSources).toBeGreaterThanOrEqual(4);
  });

  it('searches within a project with provenance, and excludes candidate lessons', async () => {
    const res = await http().post('/api/v1/history/search').set(headers).send({ projectId: project.id, query: 'xylophone export', topK: 10 }).expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.indexComplete).toBe(true);
    const types = res.body.results.map((r: { sourceType: string }) => r.sourceType).sort();
    expect(types).toEqual(['job', 'lesson', 'review', 'run']);
    const run = res.body.results.find((r: { sourceType: string }) => r.sourceType === 'run');
    expect(run).toMatchObject({ jobTitle: 'Add xylophone export', outcome: 'done', status: 'merged', prUrl: 'https://github.com/acme/web/pull/3', repoFullName: repo.fullName });
    const review = res.body.results.find((r: { sourceType: string }) => r.sourceType === 'review');
    expect(review.url).toContain('pullrequestreview-9');
    expect(JSON.stringify(res.body)).not.toContain('Candidate xylophone');
  });

  it('filters by repo and rejects a mismatched, unknown or invalid scope', async () => {
    const ok = await http().post('/api/v1/history/search').set(headers).send({ projectId: project.id, repoId: repo.id, query: 'xylophone' }).expect(200);
    expect(ok.body.status).toBe('ok');
    await http().post('/api/v1/history/search').set(headers).send({ projectId: project.id, repoId: otherRepo.id, query: 'xylophone' }).expect(400);
    await http().post('/api/v1/history/search').set(headers).send({ projectId: randomUUID(), query: 'xylophone' }).expect(404);
    await http().post('/api/v1/history/search').set(headers).send({ projectId: project.id, query: 'x', topK: 500 }).expect(400);
    await http().post('/api/v1/history/search').set(headers).send({ projectId: project.id, query: '' }).expect(400);
    await http().post('/api/v1/history/search').set(headers).send({ query: 'x' }).expect(400);
  });

  it('does not return a lesson whose approval was revoked, before the index catches up', async () => {
    const lessons = app.get(DataSource).getRepository(Lesson);
    const lesson = await lessons.findOneByOrFail({ projectId: project.id, status: 'approved' });
    await lessons.update({ id: lesson.id }, { status: 'candidate' });
    const res = await http().post('/api/v1/history/search').set(headers).send({ projectId: project.id, query: 'Stream xylophone exports', types: ['lesson'] }).expect(200);
    expect(res.body).toMatchObject({ status: 'ok', results: [] });
    expect(res.body.suppressed).toBeGreaterThan(0);
  });
});
