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
});
