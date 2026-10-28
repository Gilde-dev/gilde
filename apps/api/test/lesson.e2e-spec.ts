import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { authedAgent } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';
import { Feedback } from './../src/feedback/feedback.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { LessonSource } from './../src/lesson/lesson-source.entity.js';
import { Lesson } from './../src/lesson/lesson.entity.js';

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
  it('groups a project\'s lessons into patterns without changing them', async () => {
    const agent = await authedAgent(app);
    const slug = `patterns-${randomUUID().slice(0, 8)}`;
    const project = (await agent.post('/api/v1/projects').send({ slug, name: 'Patterns' }).expect(201)).body;
    const other = (await agent.post('/api/v1/projects').send({ slug: `${slug}-o`, name: 'Other' }).expect(201)).body;
    const repo = (await agent.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
    const job = (await agent.post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'P job', task: 'Do the pattern thing' }).expect(201)).body;
    const ds = app.get(DataSource);
    const lessons = ds.getRepository(Lesson);
    const texts = ['Run pnpm install first in a fresh session', 'Always run `pnpm install` first in a fresh session', 'The e2e database is shared'];
    const saved = [];
    for (const text of texts) saved.push(await lessons.save({ projectId: project.id, text }));
    await lessons.save({ projectId: other.id, text: texts[0] });
    await ds.getRepository(LessonSource).save({ lessonId: saved[0].id, sourceKey: `suggested_lesson:${randomUUID()}`, kind: 'suggested_lesson', jobId: job.id, excerpt: 'x' });

    const res = (await agent.get(`/api/v1/projects/${project.id}/lessons/patterns`).expect(200)).body;
    expect(res.method).toBe('text');
    expect(res.patterns).toHaveLength(1);
    expect(res.patterns[0]).toMatchObject({ size: 2, jobIds: [job.id], repoIds: [repo.id] });
    expect(res.patterns[0].members.map((m: { lessonId: string }) => m.lessonId).sort()).toEqual([saved[0].id, saved[1].id].sort());
    expect((await agent.get(`/api/v1/projects/${project.id}/lessons/patterns?minSize=3`).expect(200)).body.patterns).toEqual([]);
    await agent.get(`/api/v1/projects/${project.id}/lessons/patterns?minSize=1`).expect(400);
    await agent.get(`/api/v1/projects/${randomUUID()}/lessons/patterns`).expect(404);
    await agent.get('/api/v1/projects/not-a-uuid/lessons/patterns').expect(400);
    expect((await lessons.findBy({ projectId: project.id })).every((l) => l.status === 'candidate')).toBe(true);
  });
});
