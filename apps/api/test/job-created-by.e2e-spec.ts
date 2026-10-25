import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { randomUUID } from 'node:crypto';

import { createTestUser, tokenFor } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';

describe('Job createdBy (e2e)', () => {
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

  it('stores the authenticated user, ignores createdBy in the body and filters with me', async () => {
    const ann = await createTestUser(app, { name: 'Ann' });
    const bob = await createTestUser(app, { name: 'Bob' });
    const as = (u: typeof ann) => request.agent(app.getHttpServer()).set({ Authorization: `Bearer ${tokenFor(app, u)}` });
    const slug = `cb-${randomUUID().slice(0, 8)}`;
    const project = (await as(ann).post('/api/v1/projects').send({ slug, name: 'CB' }).expect(201)).body;
    const repo = (await as(ann).post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;

    const mine = (await as(ann).post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Mine job', task: 'Do my thing please', createdBy: bob.id }).expect(201)).body;
    const theirs = (await as(bob).post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Bob job', task: 'Do bob thing please' }).expect(201)).body;
    expect(mine.createdBy).toEqual({ id: ann.id, name: 'Ann' });

    const meList = (await as(ann).get(`/api/v1/jobs?repoId=${repo.id}&createdBy=me`).expect(200)).body;
    expect(meList.map((j: { id: string }) => j.id)).toEqual([mine.id]);
    const bobList = (await as(ann).get(`/api/v1/jobs?repoId=${repo.id}&createdBy=${bob.id}`).expect(200)).body;
    expect(bobList.map((j: { id: string }) => j.id)).toEqual([theirs.id]);

  });
});
