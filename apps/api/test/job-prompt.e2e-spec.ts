import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { Job } from './../src/job/job.entity.js';
import { Lesson } from './../src/lesson/lesson.entity.js';
import { HISTORY_OPTIONS, historyOptions } from './../src/memory/history/history.types.js';
import { MEMORY_INFRASTRUCTURE } from './../src/memory/memory.tokens.js';
import { testMemoryInfrastructure } from './../src/memory/memory.testing.js';
import { Project } from './../src/project/project.entity.js';
import { Repo } from './../src/repo/repo.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { createTestUser, tokenFor } from './helpers/auth.js';

describe('Job prompt preview with lessons (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  let headers: { Authorization: string };
  let project: Project;
  let job: Job;
  let repoId: string;
  let lessonId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.DISPATCH_LESSONS_MIN_SCORE = '0';
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-prompt-'));
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
    project = await ds.getRepository(Project).save({ slug: `prompt-${tag}`, name: 'Prompt project' });
    const repo = await ds.getRepository(Repo).save({ projectId: project.id, fullName: `acme/prompt-${tag}`, testCommands: ['pnpm test'] });
    repoId = repo.id;
    const foreign = await ds.getRepository(Project).save({ slug: `prompt-foreign-${tag}`, name: 'Foreign' });
    job = await ds.getRepository(Job).save({ projectId: project.id, repoId: repo.id, title: 'Export zebra data', task: 'Export zebra data as CSV', acceptanceCriteria: ['streams'], status: 'queued' });
    lessonId = (await ds.getRepository(Lesson).save({ projectId: project.id, text: 'Stream zebra exports', status: 'approved' })).id;
    await ds.getRepository(Lesson).save({ projectId: project.id, text: 'Candidate zebra export idea', status: 'candidate' });
    await ds.getRepository(Lesson).save({ projectId: foreign.id, text: 'Foreign zebra export lesson', status: 'approved' });
    let outcome = (await http().post('/api/v1/history/rebuild').set(headers).expect(200)).body.outcome;
    for (let i = 0; i < 50 && outcome !== 'complete'; i++) outcome = (await http().post('/api/v1/history/reconcile').set(headers).expect(200)).body.outcome;
  });
  afterAll(async () => {
    delete process.env.DISPATCH_LESSONS_MIN_SCORE;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is 401 without a token', async () => {
    await http().get(`/api/v1/jobs/${job.id}/prompt`).expect(401);
  });

  it('includes only the project approved lesson and changes no state', async () => {
    const res = await http().get(`/api/v1/jobs/${job.id}/prompt`).set(headers).expect(200);
    const payload = JSON.parse(res.body.text.slice(res.body.text.indexOf('{"gilde"')));
    expect(payload.lessons).toEqual([expect.objectContaining({ id: lessonId, text: 'Stream zebra exports', scope: 'project', status: 'approved' })]);
    expect(res.body.text).not.toContain('Candidate zebra');
    expect(res.body.text).not.toContain('Foreign zebra');
    const after = await app.get(DataSource).getRepository(Job).findOneByOrFail({ id: job.id });
    expect(after).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await app.get(DataSource).getRepository(JobRun).count({ where: { jobId: job.id } })).toBe(0);
  });

  it('drops a lesson revoked after indexing and still answers when retrieval is unavailable', async () => {
    await app.get(DataSource).getRepository(Lesson).update({ id: lessonId }, { status: 'rejected' });
    const res = await http().get(`/api/v1/jobs/${job.id}/prompt`).set(headers).expect(200);
    expect(res.body.text).not.toContain('"lessons"');
  });

  it('returns size, limit and trimmed from the same renderer', async () => {
    const res = await http().get(`/api/v1/jobs/${job.id}/prompt`).set(headers).expect(200);
    expect(res.body).toEqual({ text: res.body.text, instructionsVersion: null, length: res.body.text.length, limit: 60_000, trimmed: null });
  });

  it('returns an inspectable preview when the prompt cannot fit, instead of a 400', async () => {
    const big = await app.get(DataSource).getRepository(Job).save({ projectId: project.id, repoId, title: 'Huge', task: 'T'.repeat(61_000), status: 'queued' });
    const res = await http().get(`/api/v1/jobs/${big.id}/prompt`).set(headers).expect(200);
    expect(res.body.limit).toBe(60_000);
    expect(res.body.length).toBeGreaterThan(60_000);
    expect(res.body.length).toBe(res.body.text.length);
  });

  it('rejects task plus criteria above 40000 characters on create and update, accepting exactly 40000', async () => {
    const create = (task: number, criterion: number) => http().post(`/api/v1/repos/${repoId}/jobs`).set(headers)
      .send({ title: 'Sized job', task: 't'.repeat(task), acceptanceCriteria: ['c'.repeat(criterion)], status: 'triage' });
    await create(39_000, 1_000).expect(201);
    const rejected = await create(39_000, 1_001).expect(400);
    expect(rejected.body.message).toMatch(/40001 characters together.*over the 40000 limit/);

    const created = await create(100, 100).expect(201);
    const replace = (task: number) => http().put(`/api/v1/jobs/${created.body.id}`).set(headers)
      .send({ title: 'Sized job', task: 't'.repeat(task), acceptanceCriteria: ['c'.repeat(100)], featureId: null });
    await replace(40_000).expect(400);
    await replace(39_900).expect(200);
    const after = await http().get(`/api/v1/jobs/${created.body.id}`).set(headers).expect(200);
    expect(after.body.task).toHaveLength(39_900);
  });
});
