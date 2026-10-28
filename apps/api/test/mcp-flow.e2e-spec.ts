// Small daily limits for this file; the module reads them when AppModule is imported, hence the dynamic import.
process.env.MCP_ENABLED = 'true';
process.env.MCP_DAILY_JOB_LIMIT = '5';
process.env.MCP_DAILY_FEATURE_LIMIT = '2';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';

import { createApiKey, createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { Feature } from './../src/feature/feature.entity.js';
import { Job } from './../src/job/job.entity.js';
import { JobDependency } from './../src/job/job-dependency.entity.js';
import { McpQuotaService } from './../src/mcp/mcp-quota.service.js';
import { SpecRecording } from './../src/spec/spec-recording.entity.js';
import { SpecVersion } from './../src/spec/spec-version.entity.js';

const body = (goal = 'Ship it.') =>
  Object.entries({
    Goal: goal, Context: 'Why.', Behaviour: 'How.',
    'Acceptance criteria': '- AC-1: First\n- AC-2: Second',
    'Out of scope': 'Nothing.', 'Open questions': 'None',
  }).map(([h, t]) => `## ${h}\n\n${t}\n`).join('\n');

describe('MCP creation, specs and daily limits (e2e)', () => {
  let app: INestApplication;
  let ann: TestUser;
  let key: string;
  let projectId: string;
  let repoId: string;
  let otherRepoId: string;
  let quota: McpQuotaService;

  const http = () => request(app.getHttpServer());
  const jwt = (u: TestUser = ann) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const repo = <T extends object>(e: new () => T) => app.get<Repository<T>>(getRepositoryToken(e));
  const call = async (name: string, args: object, k = key) => {
    const res = await http().post('/api/v1/mcp').set('Accept', 'application/json, text/event-stream').set('Authorization', `Bearer ${k}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).expect(200);
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
  };
  const job = (key: string, dependsOn: string[] = [], repoOf = repoId) => ({
    key, repoId: repoOf, title: `Job ${key}`, task: `First run \`git fetch origin && git rebase origin/main\`. Do ${key}.`,
    acceptanceCriteria: [`${key} works`], dependsOn,
  });
  const plan = (extra: Record<string, unknown> = {}, jobs = [job('api'), job('web', ['api'], otherRepoId)]) => ({
    projectId, title: 'Planned feature', spec: 'Build the thing.', acceptanceCriteria: ['The thing works'], jobs, ...extra,
  });
  const simpleJob = (n: number) => ({ repoId, title: `MCP job ${n}`, task: `Do thing number ${n} carefully`, acceptanceCriteria: ['It works well'] });
  const totals = async () => ({ features: await repo(Feature).count(), jobs: await repo(Job).count(), edges: await repo(JobDependency).count() });

  beforeAll(async () => {
    const { AppModule } = await import('./../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.listen(0);
    quota = app.get(McpQuotaService);
    ann = await createTestUser(app, { name: 'Ann' });
    key = await createApiKey(app, ann);
    const slug = `flow-${randomUUID().slice(0, 8)}`;
    projectId = (await http().post('/api/v1/projects').set(jwt()).send({ slug, name: 'Flow project' }).expect(201)).body.id;
    repoId = (await http().post(`/api/v1/projects/${projectId}/repos`).set(jwt()).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    otherRepoId = (await http().post(`/api/v1/projects/${projectId}/repos`).set(jwt()).send({ fullName: `o/${slug}-web` }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('saves spec drafts as the caller and maps a stale expectedVersion to a tool error without writing', async () => {
    const created = (await call('draftSpec', { projectId, repoId, slug: 'dark-mode', title: 'Dark mode', body: body(), expectedVersion: 0 })).json();
    expect(created).toMatchObject({ saved: true, version: 1, status: 'draft', approved: false });
    const second = await call('draftSpec', { specId: created.specId, title: 'Dark mode', body: body('Changed.'), expectedVersion: 1 });
    expect(second.json()).toMatchObject({ saved: true, version: 2 });
    const stale = await call('draftSpec', { specId: created.specId, title: 'Dark mode', body: body('Late.'), expectedVersion: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('409');
    expect(await repo(SpecVersion).count({ where: { specId: created.specId } })).toBe(2);
    expect(await quota.usage(ann.id)).toEqual({ jobs: 0, features: 0 });
  });

  it('plans from an approved spec: pins the version and the recording job, jobs in triage as the caller, nothing queued', async () => {
    const spec = (await http().post(`/api/v1/projects/${projectId}/specs`).set(jwt()).send({ repoId, slug: `s-${randomUUID().slice(0, 8)}`, title: 'A spec', body: body(), expectedVersion: 0 }).expect(201)).body;
    const approved = (await http().post(`/api/v1/specs/${spec.id}/approve`).set(jwt()).send({ expectedVersion: 1 }).expect(200)).body;
    const specApproval = { version: 1, approvalId: approved.versions[0].approval.id as string };

    // A stale/wrong approval token creates nothing and consumes nothing.
    const before = await totals();
    const stale = await call('createPlannedFeature', plan({ specId: spec.id, specApproval: { ...specApproval, approvalId: randomUUID() } }));
    expect(stale.isError).toBe(true);
    expect(await totals()).toEqual(before);
    expect(await quota.usage(ann.id)).toEqual({ jobs: 0, features: 0 });

    expect((await call('planFeature', plan({ specId: spec.id, specApproval }))).json()).toMatchObject({ valid: true });
    expect(await quota.usage(ann.id)).toEqual({ jobs: 0, features: 0 });

    const r = await call('createPlannedFeature', plan({ specId: spec.id, specApproval }));
    expect(r.isError).toBe(false);
    const created = r.json() as { featureId: string; status: string; jobs: { jobId: string; status: string }[] };
    expect(created.status).toBe('draft');

    const feature = await repo(Feature).findOneByOrFail({ id: created.featureId });
    expect(feature).toMatchObject({ status: 'draft', specId: spec.id, specVersion: 1 });
    expect(feature.specPin).toMatchObject({ specId: spec.id, version: 1, approvalId: specApproval.approvalId });
    const recording = await repo(SpecRecording).findOneByOrFail({ specId: spec.id });
    expect(recording.pinnedByFeatureId).toBe(feature.id);
    const jobs = await repo(Job).find({ where: created.jobs.map((j) => ({ id: j.jobId })) });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === 'triage' && j.createdById === ann.id && j.featureId === feature.id && j.queuedAt === null)).toBe(true);
    const edges = await repo(JobDependency).find({ where: jobs.map((j) => ({ jobId: j.id })) });
    // each job waits for the recording job; web also waits for api
    expect(edges.filter((e) => e.dependsOnJobId === recording.jobId)).toHaveLength(2);
    expect(edges).toHaveLength(3);
    expect(await quota.usage(ann.id)).toEqual({ jobs: 2, features: 1 });
  });

  it('shares the job allowance between createJob and planned-feature jobs, concurrently and across keys', async () => {
    // 2 of 5 used. Six parallel creations through two keys of the same user: exactly 3 fit.
    const second = await createApiKey(app, ann, 'second key');
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('createJob', simpleJob(i), i % 2 ? second : key)));
    expect(results.filter((r) => !r.isError)).toHaveLength(3);
    expect(results.filter((r) => r.isError).every((r) => r.text.includes('Daily MCP limit reached'))).toBe(true);
    expect(await quota.usage(ann.id)).toEqual({ jobs: 5, features: 1 });

    // Over the limit: a planned feature creates nothing at all, and nothing is consumed.
    const before = await totals();
    const refused = await call('createPlannedFeature', plan({}, [job('solo')]));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Daily MCP limit reached');
    expect(await totals()).toEqual(before);
    expect(await quota.usage(ann.id)).toEqual({ jobs: 5, features: 1 });

    // Validation never consumes or needs allowance.
    expect((await call('validateJob', simpleJob(99))).isError).toBe(false);
    expect((await call('planFeature', plan())).isError).toBe(false);
    expect(await quota.usage(ann.id)).toEqual({ jobs: 5, features: 1 });
  });

  it('gives every user their own allowance', async () => {
    const bob = await createTestUser(app, { name: 'Bob' });
    const r = await call('createJob', simpleJob(1), await createApiKey(app, bob));
    expect(r.isError).toBe(false);
    const stored = await repo(Job).findOneByOrFail({ id: r.json().jobId });
    expect(stored).toMatchObject({ status: 'triage', createdById: bob.id });
    expect(await quota.usage(bob.id)).toEqual({ jobs: 1, features: 0 });
  });

  it('counts only what was actually created: an invalid job consumes nothing', async () => {
    const bob = await createTestUser(app);
    const bobKey = await createApiKey(app, bob);
    const bad = await call('createJob', { ...simpleJob(1), repoId: randomUUID() }, bobKey);
    expect(bad.isError).toBe(true);
    expect(await quota.usage(bob.id)).toEqual({ jobs: 0, features: 0 });
  });
});
