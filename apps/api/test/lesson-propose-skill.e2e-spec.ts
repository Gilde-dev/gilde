import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { authedAgent, createApiKey, createTestUser } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';
import { Lesson } from './../src/lesson/lesson.entity.js';
import { LessonService } from './../src/lesson/lesson.service.js';
import { LessonSource } from './../src/lesson/lesson-source.entity.js';
import { Project } from './../src/project/project.entity.js';
import { Repo } from './../src/repo/repo.entity.js';
import { SkillLibraryResolver } from './../src/skill/skill-library.resolver.js';

describe('Propose a skill from a lesson pattern (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const fakeLibrary = { resolve: async () => ({ kind: 'repo', repoFullName: 'o/library', library: { getCatalog: async () => [{ name: 'existing-skill', scope: 'global' }] } }) };
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SkillLibraryResolver).useValue(fakeLibrary)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  async function fixture() {
    const agent = await authedAgent(app);
    const slug = `skillprop-${randomUUID().slice(0, 8)}`;
    const project = (await agent.post('/api/v1/projects').send({ slug, name: 'Skill proposals' }).expect(201)).body;
    const repo = (await agent.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
    const library = (await agent.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/lib-${slug}` }).expect(201)).body;
    const job = (await agent.post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Source job', task: 'Do the thing for a while' }).expect(201)).body;
    const ds = app.get(DataSource);
    await ds.getRepository(Repo).update({ id: library.id }, { testCommands: ['pnpm validate'] });
    await ds.getRepository(Project).update({ id: project.id }, { skillsLibrary: 'repo', skillsLibraryRepoId: library.id });
    const lessons = ds.getRepository(Lesson);
    const texts = ['Run pnpm install first in a fresh session', 'Always run `pnpm install` first in a fresh session'];
    const saved: Lesson[] = [];
    for (const text of texts) saved.push(await lessons.save({ projectId: project.id, text }));
    await ds.getRepository(LessonSource).save({ lessonId: saved[0].id, sourceKey: `suggested_lesson:${randomUUID()}`, kind: 'suggested_lesson', jobId: job.id, excerpt: 'x' });
    const pattern = (await agent.get(`/api/v1/projects/${project.id}/lessons/patterns`).expect(200)).body.patterns[0];
    return { agent, project, repo, library, job, lessons, saved, pattern, ds };
  }
  const url = (f: { project: { id: string }; pattern: { id: string } }) => `/api/v1/projects/${f.project.id}/lessons/patterns/${f.pattern.id}/propose-skill`;

  it('creates one triage job in the library repo, moves the lessons to applying and finishes them when the job merges', async () => {
    const f = await fixture();
    const body = { name: 'pnpm-install', scope: 'stack', stacks: ['nestjs'] };
    const res = (await f.agent.post(url(f)).send(body).expect(201)).body;
    expect(res).toMatchObject({ skillName: 'pnpm-install' });
    expect(res.lessonIds.sort()).toEqual(f.saved.map((l) => l.id).sort());

    const job = (await f.agent.get(`/api/v1/jobs/${res.jobId}`).expect(200)).body;
    expect(job).toMatchObject({ repoId: f.library.id, status: 'triage' });
    expect(job.task).toContain('Run pnpm install first in a fresh session');
    expect(job.task).toContain('pnpm validate');
    for (const l of await f.lessons.findBy({ projectId: f.project.id })) {
      expect(l).toMatchObject({ status: 'applying', appliedJobId: res.jobId, appliedSkillName: 'pnpm-install', targetKind: 'library_skill' });
    }

    // the pattern is gone (its members are applying), the same name is taken, and the id is now stale
    await f.agent.post(url(f)).send(body).expect(409);
    await app.get(LessonService).onJobEnded(res.jobId, 'merged');
    const done = await f.agent.get(`/api/v1/lessons?projectId=${f.project.id}&status=applied`).expect(200);
    expect(done.body).toHaveLength(2);
    expect(done.body[0]).toMatchObject({ appliedSkillName: 'pnpm-install' });
  });

  it('returns lessons to approved when the job fails', async () => {
    const f = await fixture();
    const res = (await f.agent.post(url(f)).send({ name: 'pnpm-install', scope: 'global' }).expect(201)).body;
    await app.get(LessonService).onJobEnded(res.jobId, 'cancelled', 'nope');
    expect((await f.lessons.findBy({ projectId: f.project.id })).map((l) => l.status)).toEqual(['approved', 'approved']);
  });

  it('validates the body, refuses duplicate names and stale patterns, and creates no job on failure', async () => {
    const f = await fixture();
    await f.agent.post(url(f)).send({ name: 'Bad Name', scope: 'global' }).expect(400);
    await f.agent.post(url(f)).send({ name: 'ok-name', scope: 'stack' }).expect(400);
    await f.agent.post(url(f)).send({ name: 'existing-skill', scope: 'global' }).expect(409);
    await f.agent.post(`/api/v1/projects/${f.project.id}/lessons/patterns/${'0'.repeat(32)}/propose-skill`).send({ name: 'ok-name', scope: 'global' }).expect(409);
    const jobs = (await f.agent.get(`/api/v1/jobs?projectId=${f.project.id}`).expect(200)).body;
    expect(jobs.filter((j: { repoId: string }) => j.repoId === f.library.id)).toHaveLength(0);
    expect((await f.lessons.findBy({ projectId: f.project.id })).every((l) => l.status === 'candidate')).toBe(true);
  });

  it('refuses a project without a repo-backed library', async () => {
    const f = await fixture();
    await f.ds.getRepository(Project).update({ id: f.project.id }, { skillsLibrary: 'none', skillsLibraryRepoId: null });
    await f.agent.post(url(f)).send({ name: 'ok-name', scope: 'global' }).expect(409);
  });

  it('is for verified humans only: no token, an API key', async () => {
    const f = await fixture();
    const user = await createTestUser(app);
    const key = await createApiKey(app, user);
    await request(app.getHttpServer()).post(url(f)).send({ name: 'ok-name', scope: 'global' }).expect(401);
    await request(app.getHttpServer()).post(url(f)).set({ Authorization: `Bearer ${key}` }).send({ name: 'ok-name', scope: 'global' }).expect(401);
    expect((await f.lessons.findBy({ projectId: f.project.id })).every((l) => l.status === 'candidate')).toBe(true);
  });

  it('accepts library_skill as a settable lesson target kind', async () => {
    const f = await fixture();
    const body = { text: 'Edited', targetKind: 'library_skill', targetRepoId: f.library.id, note: null };
    expect((await f.agent.put(`/api/v1/lessons/${f.saved[0].id}`).send(body).expect(200)).body).toMatchObject({ targetKind: 'library_skill' });
  });
});
