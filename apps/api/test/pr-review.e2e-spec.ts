import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';

import { createApiKey, createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { Job } from './../src/job/job.entity.js';
import { PrReviewService } from './../src/pr-review/pr-review.service.js';

const LIMITS = { timeoutMs: 60_000, maxSteps: 8, maxInputTokens: 100_000, maxOutputTokens: 4_000, maxRevisions: 2 };

describe('PR review history (e2e)', () => {
  let app: INestApplication;
  let ann: TestUser;
  const http = () => request(app.getHttpServer());
  const jwt = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const jobs = () => app.get<Repository<Job>>(getRepositoryToken(Job));

  beforeAll(async () => {
    const { AppModule } = await import('./../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.listen(0);
    ann = await createTestUser(app, { name: 'Ann' });
  });
  afterAll(() => app.close());

  const newJob = () => jobs().save(jobs().create({
    projectId: randomUUID(), repoId: randomUUID(), title: 'Reviewed', task: 'Do it', status: 'pr_open', prNumber: 3, headSha: 'abc123', prUrl: 'https://github.com/o/r/pull/3',
  }));

  it('requires authentication and rejects bad ids and queries', async () => {
    const job = await newJob();
    await http().get(`/api/v1/jobs/${job.id}/reviews`).expect(401);
    await http().get('/api/v1/jobs/not-a-uuid/reviews').set(jwt(ann)).expect(400);
    await http().get(`/api/v1/jobs/${randomUUID()}/reviews`).set(jwt(ann)).expect(404);
    await http().get(`/api/v1/jobs/${job.id}/reviews?pageSize=0`).set(jwt(ann)).expect(400);
  });

  it('returns pending, running and final reviews with limits, count and links, for a JWT and an API key', async () => {
    const job = await newJob();
    const service = app.get(PrReviewService);
    const empty = await http().get(`/api/v1/jobs/${job.id}/reviews`).set(jwt(ann)).expect(200);
    expect(empty.body).toEqual({ items: [], page: 1, pageSize: 20, total: 0, revisionCount: 0 });

    const claim = await service.claimExecution({ jobId: job.id, prNumber: 3, headSha: 'abc123', limits: LIMITS, baseSha: 'base9', baseRef: 'main' });
    if (!claim.claimed) throw new Error('not claimed');
    const pending = await http().get(`/api/v1/jobs/${job.id}/reviews`).set(jwt(ann)).expect(200);
    expect(pending.body.items[0]).toMatchObject({ status: 'pending', headSha: 'abc123', baseSha: 'base9', result: null, limits: LIMITS });

    await service.markRunning(claim.review.id);
    await service.complete(claim.review.id, { kind: 'incomplete', reasonCode: 'too_large', reason: 'too large', partialFindings: [], suggestions: [] });
    await service.recordPublication(claim.review.id, { id: '42', url: 'https://github.com/o/r/pull/3#pullrequestreview-42' });

    const key = await createApiKey(app, ann);
    const res = await http().get(`/api/v1/jobs/${job.id}/reviews`).set({ Authorization: `Bearer ${key}` }).expect(200);
    expect(res.body).toMatchObject({ total: 1, revisionCount: 0 });
    expect(res.body.items[0]).toMatchObject({
      status: 'incomplete', verdict: null, reasonCode: 'too_large', reason: 'too large',
      result: { kind: 'incomplete', reasonCode: 'too_large' },
      links: { review: 'https://github.com/o/r/pull/3#pullrequestreview-42', pullRequest: 'https://github.com/o/r/pull/3' },
    });
    expect(JSON.stringify(res.body)).not.toContain('claimedBy');
  });

  it('survives service recreation: the records and the revision count are read from the database', async () => {
    const job = await newJob();
    const first = app.get(PrReviewService);
    const claim = await first.claimExecution({ jobId: job.id, prNumber: 3, headSha: 'abc123', limits: LIMITS });
    if (!claim.claimed) throw new Error('not claimed');
    await first.markRunning(claim.review.id);
    await first.complete(claim.review.id, {
      kind: 'complete', verdict: 'blocking', summary: 's', inspection: { diffComplete: true, contextComplete: true }, coverage: [], suggestions: [],
      blockingFindings: [{ title: 't', evidence: 'e', impact: 'i', requestedFix: 'f' }],
    });
    expect(await first.claimRouting(claim.review.id, 'revision')).toEqual({ claimed: true });

    const recreated = new PrReviewService(app.get(getRepositoryToken((await import('./../src/pr-review/pr-review.entity.js')).PrReview)), jobs(), app.get((await import('typeorm')).DataSource));
    expect(await recreated.claimExecution({ jobId: job.id, prNumber: 3, headSha: 'abc123', limits: LIMITS })).toMatchObject({ claimed: false, reason: 'exists' });
    const res = await http().get(`/api/v1/jobs/${job.id}/reviews`).set(jwt(ann)).expect(200);
    expect(res.body).toMatchObject({ total: 1, revisionCount: 1 });
    expect(res.body.items[0]).toMatchObject({ status: 'complete', verdict: 'blocking', routing: { state: 'claimed', action: 'revision' } });
  });
});
