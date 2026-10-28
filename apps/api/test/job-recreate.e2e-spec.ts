import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';

import { createTestUser, tokenFor } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';
import { Job } from './../src/job/job.entity.js';

describe('Recreate job (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).post(`/api/v1/jobs/${randomUUID()}/recreate`).expect(401);
  });

  it('recreates a merged-without-work job in triage for the acting user and rewires dependents', async () => {
    const ann = await createTestUser(app, { name: 'Ann' });
    const bob = await createTestUser(app, { name: 'Bob' });
    const as = (u: typeof ann) => request.agent(app.getHttpServer()).set({ Authorization: `Bearer ${tokenFor(app, u)}` });
    const slug = `rc-${randomUUID().slice(0, 8)}`;
    const project = (await as(ann).post('/api/v1/projects').send({ slug, name: 'RC' }).expect(201)).body;
    const repo = (await as(ann).post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
    const source = (await as(ann).post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Source job', task: 'Do the source thing', acceptanceCriteria: ['it works'], status: 'triage' }).expect(201)).body;
    const dependent = (await as(ann).post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Dependent job', task: 'Do the dependent thing', dependsOn: [source.id], status: 'triage' }).expect(201)).body;
    const jobs = app.get<Repository<Job>>(getRepositoryToken(Job));

    // not eligible while it is not merged without work
    await as(ann).post(`/api/v1/jobs/${source.id}/recreate`).expect(409);
    await as(ann).post(`/api/v1/jobs/${randomUUID()}/recreate`).expect(404);

    await jobs.update({ id: source.id }, { status: 'merged', mergedBlocked: true, prNumber: 4, prUrl: 'http://pr/4' });
    const listed = (await as(ann).get(`/api/v1/jobs?projectId=${project.id}`).expect(200)).body as Array<{ id: string; blockedBy: unknown[]; failedDependency?: boolean; mergedBlocked: boolean }>;
    expect(listed.find((j) => j.id === source.id)!.mergedBlocked).toBe(true);
    expect(listed.find((j) => j.id === dependent.id)).toMatchObject({ failedDependency: true, blockedBy: [{ id: source.id, status: 'merged', mergedBlocked: true }] });

    const created = (await as(bob).post(`/api/v1/jobs/${source.id}/recreate`).expect(200)).body;
    expect(created).toMatchObject({
      status: 'triage', title: 'Source job', acceptanceCriteria: ['it works'], attempts: 0, prNumber: null,
      createdBy: { id: bob.id, name: 'Bob' }, recreatedFromId: source.id,
    });
    const again = (await as(ann).post(`/api/v1/jobs/${source.id}/recreate`).expect(200)).body;
    expect(again.id).toBe(created.id);

    const detail = (await as(ann).get(`/api/v1/jobs/${source.id}`).expect(200)).body;
    expect(detail).toMatchObject({ status: 'merged', prNumber: 4, replacedById: created.id, mergedBlocked: true });
    const dep = (await as(ann).get(`/api/v1/jobs/${dependent.id}`).expect(200)).body;
    expect(dep.dependsOn).toEqual([created.id]);
    expect(dep.status).toBe('triage');
  });
});
