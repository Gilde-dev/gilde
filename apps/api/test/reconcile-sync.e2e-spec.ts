import { randomBytes } from 'node:crypto';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { ApiKeyService } from './../src/api-key/api-key.service.js';
import { GITHUB_PORT, type GitHubPull } from './../src/github/github.port.js';
import { Job } from './../src/job/job.entity.js';
import { UserService } from './../src/user/user.service.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

describe('Job sync and project reconcile (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let projectId: string;
  let repoId: string;
  let pulls: Map<number, GitHubPull>;
  let githubError: Error | null;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const prUrl = 'https://github.com/o/r/pull/7';

  const github = {
    isConfigured: () => true,
    getPull: async (_f: string, n: number) => {
      if (githubError) throw githubError;
      return pulls.get(n);
    },
    listRecentPulls: async () => [],
    listWorkflowRuns: async () => [],
  };

  const seedJob = (status: Job['status'], over: Partial<Job> = {}) => {
    const jobs = app.get(DataSource).getRepository(Job);
    return jobs.save(jobs.create({
      projectId, repoId, title: 'T', task: 'do', status, queuedAt: new Date(), attempts: 1, prNumber: 7, prUrl, branch: 'b', headSha: 'sha1', ...over,
    }));
  };

  beforeEach(async () => {
    pulls = new Map([[7, { number: 7, state: 'closed', merged: true, headSha: 'sha1', headRef: 'b', htmlUrl: prUrl, body: null }]]);
    githubError = null;
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GITHUB_PORT).useValue(github)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = randomBytes(4).toString('hex');
    projectId = (await http().post('/api/v1/projects').set(as(ann)).send({ name: `P ${slug}`, slug: `p-${slug}` })).body.id;
    repoId = (await http().post(`/api/v1/projects/${projectId}/repos`).set(as(ann)).send({ fullName: `o/${slug}` }).expect(201)).body.id;
  });

  afterEach(() => app.close());

  it('syncs a job whose merge webhook was missed', async () => {
    const job = await seedJob('awaiting_review');
    const res = await http().post(`/api/v1/jobs/${job.id}/sync`).set(as(ann)).expect(200);
    expect(res.body).toMatchObject({
      jobId: job.id, pr: { number: 7, state: 'closed', merged: true }, before: { status: 'awaiting_review' }, after: { status: 'merged' }, changes: ['PR #7 merged'],
    });
    const again = await http().post(`/api/v1/jobs/${job.id}/sync`).set(as(ann)).expect(200);
    expect(again.body.changes).toEqual([]);
  });

  it('answers 404, 409 and a safe 502', async () => {
    await http().post('/api/v1/jobs/11111111-1111-4111-8111-111111111111/sync').set(as(ann)).expect(404);
    const queued = await seedJob('queued', { prNumber: null });
    await http().post(`/api/v1/jobs/${queued.id}/sync`).set(as(ann)).expect(409);

    const job = await seedJob('pr_open');
    githubError = new Error('GitHub GET /repos/o/r/pulls/7 failed: 403 token ghs_SECRET');
    const res = await http().post(`/api/v1/jobs/${job.id}/sync`).set(as(ann)).expect(502);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(res.body.message).toMatch(/403/);
    expect((await app.get(DataSource).getRepository(Job).findOneByOrFail({ id: job.id })).status).toBe('pr_open');
  });

  it('refuses API keys, bots, unauthenticated callers and stale identities on both routes', async () => {
    const job = await seedJob('awaiting_review');
    const { key } = await app.get(ApiKeyService).create(ann.id, { name: 'k' });
    const bot = await app.get(UserService).create({ name: 'Bot', email: `bot-${Date.now()}@example.com`, password: 'correct-horse-battery' }, { isBot: true });
    const paths = [`/api/v1/jobs/${job.id}/sync`, `/api/v1/projects/${projectId}/reconcile`];
    for (const path of paths) {
      await http().post(path).expect(401);
      await http().post(path).set({ Authorization: `Bearer ${key}` }).expect(401);
      await http().post(path).set(as(bot)).expect(403);
    }
    const stale = await createTestUser(app);
    const token = tokenFor(app, stale);
    await app.get(UserService).markBot(stale.email);
    for (const path of paths) await http().post(path).set({ Authorization: `Bearer ${token}` }).expect(403);
    expect((await app.get(DataSource).getRepository(Job).findOneByOrFail({ id: job.id })).status).toBe('awaiting_review');
  });

  it('reconciles one project only and leaves the global endpoint alone', async () => {
    const mine = await seedJob('awaiting_review');
    const slug = randomBytes(4).toString('hex');
    const other = (await http().post('/api/v1/projects').set(as(ann)).send({ name: `Q ${slug}`, slug: `q-${slug}` })).body.id;
    const otherRepo = (await http().post(`/api/v1/projects/${other}/repos`).set(as(ann)).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    const theirs = await seedJob('awaiting_review', { projectId: other, repoId: otherRepo });

    await http().post('/api/v1/projects/11111111-1111-4111-8111-111111111111/reconcile').set(as(ann)).expect(404);
    const res = await http().post(`/api/v1/projects/${projectId}/reconcile`).set(as(ann)).expect(200);
    expect(res.body).toEqual({ checked: 1, corrected: 1 });
    const jobs = app.get(DataSource).getRepository(Job);
    expect((await jobs.findOneByOrFail({ id: mine.id })).status).toBe('merged');
    expect((await jobs.findOneByOrFail({ id: theirs.id })).status).toBe('awaiting_review');

    // The global endpoint keeps its response shape and accepts API keys.
    const { key } = await app.get(ApiKeyService).create(ann.id, { name: 'k2' });
    const global = await http().post('/api/v1/reconcile').set({ Authorization: `Bearer ${key}` }).expect(201);
    expect(Object.keys(global.body).sort()).toEqual(['checked', 'corrected']);
    expect((await jobs.findOneByOrFail({ id: theirs.id })).status).toBe('merged');
  });
});
