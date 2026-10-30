import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';

import { createApiKey, createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { GITHUB_PORT, type GitHubPull, type GitHubWorkflowRun } from './../src/github/github.port.js';
import { Job } from './../src/job/job.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { PrReview } from './../src/pr-review/pr-review.entity.js';
import { PrReviewService } from './../src/pr-review/pr-review.service.js';
import { UserService } from './../src/user/user.service.js';
import type { ReviewResult } from './../src/pr-review/review-result.js';

const LIMITS = { timeoutMs: 60_000, maxSteps: 8, maxInputTokens: 100_000, maxOutputTokens: 4_000, maxRevisions: 2 };
const blocking: ReviewResult = {
  kind: 'complete', verdict: 'blocking', summary: 's', inspection: { diffComplete: true, contextComplete: true }, coverage: [], suggestions: [],
  blockingFindings: [{ title: 't', evidence: 'e', impact: 'i', requestedFix: 'f' }],
};

describe('Automatic review human override (e2e)', () => {
  let app: INestApplication;
  let ann: TestUser;
  let pull: GitHubPull;
  let runs: Partial<GitHubWorkflowRun>[];
  const github = {
    isConfigured: () => true,
    getPull: async () => pull,
    listWorkflowRuns: async () => runs,
    listRecentPulls: async () => [],
  };
  const http = () => request(app.getHttpServer());
  const jwt = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const repo = <T extends object>(e: new () => T) => app.get<Repository<T>>(getRepositoryToken(e));
  const service = () => app.get(PrReviewService);
  let repoId: string;
  let projectId: string;

  beforeAll(async () => {
    const { AppModule } = await import('./../src/app.module.js');
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(GITHUB_PORT).useValue(github).compile())
      .createNestApplication();
    app.setGlobalPrefix('/api');
    await app.listen(0);
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = randomUUID().slice(0, 8);
    projectId = (await http().post('/api/v1/projects').set(jwt(ann)).send({ name: `P ${slug}`, slug: `p-${slug}` })).body.id;
    repoId = (await http().post(`/api/v1/projects/${projectId}/repos`).set(jwt(ann)).send({ fullName: `o/${slug}` }).expect(201)).body.id;
  });
  afterAll(() => app.close());

  beforeEach(() => {
    pull = { number: 3, state: 'open', merged: false, draft: false, headSha: 'abc123', headRef: 'b', htmlUrl: 'https://github.com/o/r/pull/3', body: null } as GitHubPull;
    runs = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
  });

  const newJob = (over: Partial<Job> = {}) => repo(Job).save(repo(Job).create({
    projectId, repoId, title: 'Reviewed', task: 'Do it', status: 'pr_open', prNumber: 3, headSha: 'abc123', prUrl: 'https://github.com/o/r/pull/3', ...over,
  }));
  const review = async (job: Job, result?: ReviewResult) => {
    const c = await service().claimExecution({ jobId: job.id, prNumber: 3, headSha: job.headSha!, limits: LIMITS });
    if (!c.claimed) throw new Error('not claimed');
    if (result) { await service().markRunning(c.review.id); await service().complete(c.review.id, result); }
    return c.review;
  };
  const body = (r: PrReview, over: Record<string, unknown> = {}) => ({ reviewId: r.id, headSha: r.headSha, reason: 'I read the diff', ...over });
  const post = (job: Job, payload: unknown, user: TestUser = ann) => http().post(`/api/v1/jobs/${job.id}/review-override`).set(jwt(user)).send(payload as object);

  it('requires a JWT of a persisted human: no auth, API keys (even human-owned) and bots are refused', async () => {
    const job = await newJob();
    const r = await review(job);
    await http().post(`/api/v1/jobs/${job.id}/review-override`).send(body(r)).expect(401);
    const key = await createApiKey(app, ann);
    const viaKey = await http().post(`/api/v1/jobs/${job.id}/review-override`).set({ Authorization: `Bearer ${key}` }).send(body(r));
    expect([401, 403]).toContain(viaKey.status);
    const bot = await createTestUser(app);
    await app.get(UserService).markBot(bot.email);
    await post(job, body(r), bot).expect(403);
    expect((await repo(Job).findOneByOrFail({ id: job.id })).status).toBe('pr_open');
    expect((await repo(PrReview).findOneByOrFail({ id: r.id })).suppressed).toBe(false);
  });

  it('validates the body: a blank or missing reason, a bad id and a missing head are 400', async () => {
    const job = await newJob();
    const r = await review(job);
    await post(job, body(r, { reason: '   ' })).expect(400);
    await post(job, { reviewId: r.id, headSha: r.headSha }).expect(400);
    await post(job, body(r, { reviewId: 'nope' })).expect(400);
    await post(job, { reviewId: r.id, reason: 'x' }).expect(400);
    await http().post('/api/v1/jobs/not-a-uuid/review-override').set(jwt(ann)).send(body(r)).expect(400);
    await http().post(`/api/v1/jobs/${randomUUID()}/review-override`).set(jwt(ann)).send(body(r)).expect(404);
    await post(job, body(r, { reviewId: randomUUID() })).expect(404);
  });

  it('overrides a pending review: job to awaiting_review, audit persisted and visible in the history, approval kept', async () => {
    const job = await newJob({ needsApproval: true, approvalReason: 'protected paths' });
    const r = await review(job);
    const res = await post(job, body(r, { reason: '  Reviewed by hand  ' })).expect(200);
    expect(res.body.override).toMatchObject({ suppressed: true, byUserId: ann.id, reason: 'Reviewed by hand', at: expect.any(String), overriddenResult: { status: 'pending' } });
    expect(await repo(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'awaiting_review', needsApproval: true });
    const history = await http().get(`/api/v1/jobs/${job.id}/reviews`).set(jwt(ann)).expect(200);
    expect(history.body.items[0].override).toMatchObject({ suppressed: true, reason: 'Reviewed by hand' });
    await post(job, body(r)).expect(409);
  });

  it('cancels only the pending automatic revision of a queued job', async () => {
    const job = await newJob();
    const r = await review(job, blocking);
    expect((await service().applyRouting(r.id, { action: 'revision', reason: 'fix', maxAttempts: 5 })).applied).toBe(true);
    await post(job, body(r)).expect(200);
    expect(await repo(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'awaiting_review', autoRevisionReviewId: null, autoReviewRevisions: 1 });
  });

  it('overrides an automatically parked job, but not one parked or queued by hand', async () => {
    const job = await newJob();
    const r = await review(job, blocking);
    await service().applyRouting(r.id, { action: 'park', reason: 'limit' });
    await post(job, body(r)).expect(200);

    const manual = await newJob();
    const mr = await review(manual, blocking);
    await repo(Job).update(manual.id, { status: 'parked' });
    await post(manual, body(mr)).expect(409);
    const queued = await newJob();
    const qr = await review(queued, blocking);
    await repo(Job).update(queued.id, { status: 'queued' });
    await post(queued, body(qr)).expect(409);
    expect((await repo(Job).findOneByOrFail({ id: queued.id })).status).toBe('queued');
  });

  it('rejects stale heads, other jobs\' reviews, terminal jobs and active coding rounds', async () => {
    const job = await newJob();
    const r = await review(job);
    await post(job, body(r, { headSha: 'old' })).expect(409);
    const other = await newJob();
    await post(other, body(r)).expect(404);

    await repo(Job).update(job.id, { headSha: 'newhead' });
    await post(job, body(r)).expect(409);
    await repo(Job).update(job.id, { headSha: 'abc123' });

    await repo(JobRun).save(repo(JobRun).create({ jobId: job.id, projectId, repoId, attempt: 1, status: 'fired' } as Partial<JobRun> as JobRun));
    await post(job, body(r)).expect(409);
    await repo(JobRun).delete({ jobId: job.id });

    await repo(Job).update(job.id, { status: 'merged' });
    await post(job, body(r)).expect(409);
    expect((await repo(PrReview).findOneByOrFail({ id: r.id })).suppressed).toBe(false);
  });

  it('does not bypass CI: red or running CI, a draft or a moved PR is refused', async () => {
    const job = await newJob();
    const r = await review(job);
    runs = [{ name: 'CI', status: 'completed', conclusion: 'failure' }];
    await post(job, body(r)).expect(409);
    runs = [{ name: 'CI', status: 'in_progress', conclusion: null }];
    await post(job, body(r)).expect(409);
    runs = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
    pull = { ...pull, draft: true } as GitHubPull;
    await post(job, body(r)).expect(409);
    pull = { ...pull, draft: false, state: 'closed' } as GitHubPull;
    await post(job, body(r)).expect(409);
    pull = { ...pull, state: 'open', headSha: 'other' } as GitHubPull;
    await post(job, body(r)).expect(409);
    expect((await repo(Job).findOneByOrFail({ id: job.id })).status).toBe('pr_open');
  });

  it('a new head after an override needs fresh review: it is not suppressed', async () => {
    const job = await newJob();
    const r = await review(job);
    await post(job, body(r)).expect(200);
    await repo(Job).update(job.id, { status: 'pr_open', headSha: 'def456' });
    const next = await service().claimExecution({ jobId: job.id, prNumber: 3, headSha: 'def456', limits: LIMITS });
    expect(next.claimed && next.review.suppressed).toBe(false);
    pull = { ...pull, headSha: 'def456' } as GitHubPull;
    await post(job, body(r)).expect(409);
  });

  it('concurrent overrides of one decision have a single winner', async () => {
    const job = await newJob();
    const r = await review(job);
    const results = await Promise.all(Array.from({ length: 5 }, () => post(job, body(r))));
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409)).toHaveLength(4);
  });
});
