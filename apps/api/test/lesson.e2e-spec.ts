import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { authedAgent } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';
import { Feedback } from './../src/feedback/feedback.entity.js';
import { JobRun } from './../src/run/run.entity.js';

describe('Lessons (e2e)', () => {
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

  it('collects, lists, replaces, approves and merges', async () => {
    const agent = await authedAgent(app);
    const http = () => agent;
    const slug = `lessons-${randomUUID().slice(0, 8)}`;
    const project = (await http().post('/api/v1/projects').send({ slug, name: 'Lessons' }).expect(201)).body;
    const repo = (await http().post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
    const job = (await http().post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Lesson job', task: 'Do the lesson thing' }).expect(201)).body;

    const ds = app.get(DataSource);
    await ds.getRepository(JobRun).save({
      jobId: job.id, projectId: project.id, repoId: repo.id, attempt: 1,
      result: { outcome: 'done', summary: 's', suggestedLesson: 'Document the test command' }, retro: 'Tests were slow',
    });
    await ds.getRepository(Feedback).save({
      jobId: job.id, projectId: project.id, repoId: repo.id, prNumber: 1, kind: 'comment', githubId: randomUUID(),
      author: 'a', authorAssociation: 'NONE', body: 'ignored', url: 'u',
    });
    await ds.getRepository(Feedback).save({
      jobId: job.id, projectId: project.id, repoId: repo.id, prNumber: 1, kind: 'comment', githubId: randomUUID(),
      author: 'm', authorAssociation: 'MEMBER', body: 'Use the helper', url: 'u',
    });

    const collected = await http().post('/api/v1/lessons/collect').expect(200);
    expect(collected.body.created).toBeGreaterThanOrEqual(2);
    expect((await http().post('/api/v1/lessons/collect').expect(200)).body).toEqual({ created: 0 });

    const list = (await http().get(`/api/v1/lessons?projectId=${project.id}&status=candidate`).expect(200)).body;
    expect(list).toHaveLength(2);
    expect(list.every((l: { sourceCount: number }) => l.sourceCount === 1)).toBe(true);
    const [a, b] = list;

    await http().post(`/api/v1/lessons/${a.id}/approve`).expect(400);
    const patched = (await http().put(`/api/v1/lessons/${a.id}`).send({ text: 'Edited', targetKind: 'agents_md', targetRepoId: repo.id, note: 'n' }).expect(200)).body;
    expect(patched).toMatchObject({ text: 'Edited', targetKind: 'agents_md', targetRepoId: repo.id, note: 'n' });
    expect((await http().post(`/api/v1/lessons/${a.id}/approve`).expect(200)).body.status).toBe('approved');
    await http().post(`/api/v1/lessons/${a.id}/approve`).expect(409);
    await http().get(`/api/v1/lessons/${a.id}`).expect(200);

    const merged = (await http().post('/api/v1/lessons/merge').send({ targetId: a.id, lessonIds: [b.id] }).expect(200)).body;
    expect(merged.sources).toHaveLength(2);
    expect(merged.sourceCount).toBe(1);
    await http().get(`/api/v1/lessons/${b.id}`).expect(404);

    await http().post(`/api/v1/lessons/${a.id}/reject`).expect(200);
    await http().post(`/api/v1/lessons/${a.id}/reopen`).expect(200);
  });
});
