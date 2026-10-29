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

describe('Merge conflicts (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let projectId: string;
  let repoId: string;
  let mergeableState: string | null;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const jobs = () => app.get(DataSource).getRepository(Job);
  const reload = (id: string) => jobs().findOneByOrFail({ id });

  const github = {
    isConfigured: () => true,
    getPull: async (_f: string, n: number): Promise<GitHubPull> => ({
      number: n, state: 'open', merged: false, headSha: 'sha1', headRef: 'b', htmlUrl: 'u', body: null, mergeableState,
    }),
    listRecentPulls: async () => [],
    listWorkflowRuns: async () => [],
  };

  const seedJob = (status: Job['status'], over: Partial<Job> = {}) =>
    jobs().save(jobs().create({
      projectId, repoId, title: 'T', task: 'do', status, queuedAt: new Date(), attempts: 1, prNumber: 7, prUrl: 'u', branch: 'b', headSha: 'sha1', createdById: ann.id, ...over,
    }));

  beforeEach(async () => {
    mergeableState = 'dirty';
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

  it('detects a conflict through Sync from GitHub, exposes it, and clears it when resolved', async () => {
    const job = await seedJob('awaiting_review');
    await http().post(`/api/v1/jobs/${job.id}/sync`).set(as(ann)).expect(200);
    const detail = (await http().get(`/api/v1/jobs/${job.id}`).set(as(ann)).expect(200)).body;
    expect(detail).toMatchObject({ mergeConflict: true, status: 'awaiting_review' });
    expect(detail.mergeConflictCheckedAt).toEqual(expect.any(String));

    mergeableState = 'unknown';
    await http().post(`/api/v1/jobs/${job.id}/sync`).set(as(ann)).expect(200);
    expect((await reload(job.id)).mergeConflict).toBe(true);

    mergeableState = 'clean';
    await http().post(`/api/v1/projects/${projectId}/reconcile`).set(as(ann)).expect(200);
    expect(await reload(job.id)).toMatchObject({ mergeConflict: false });
  });

  it('fix-conflicts sends the job back for verified humans only, 409 when not applicable', async () => {
    const job = await seedJob('awaiting_review', { mergeConflict: true, attempts: 3 });
    const { key } = await app.get(ApiKeyService).create(ann.id, { name: 'k' });
    const bot = await app.get(UserService).create({ name: 'Bot', email: `bot-${Date.now()}@example.com`, password: 'correct-horse-battery' }, { isBot: true });
    const path = `/api/v1/jobs/${job.id}/fix-conflicts`;
    await http().post(path).expect(401);
    await http().post(path).set({ Authorization: `Bearer ${key}` }).expect(401);
    await http().post(path).set(as(bot)).expect(403);
    expect((await reload(job.id)).status).toBe('awaiting_review');

    await http().post('/api/v1/jobs/11111111-1111-4111-8111-111111111111/fix-conflicts').set(as(ann)).expect(404);
    const clean = await seedJob('awaiting_review');
    await http().post(`/api/v1/jobs/${clean.id}/fix-conflicts`).set(as(ann)).expect(409);

    const res = await http().post(path).set(as(ann)).expect(200);
    expect(res.body).toMatchObject({ status: 'queued', attempts: 3, prNumber: 7 });
    expect(res.body.lastReason).toMatch(/^Merge conflicts with main\. Run `git fetch origin && git merge origin\/main`/);
    await http().post(path).set(as(ann)).expect(409);
  });
});
