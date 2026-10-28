import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { Job } from './../src/job/job.entity.js';
import { Project } from './../src/project/project.entity.js';
import { Repo } from './../src/repo/repo.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { authedAgent } from './helpers/auth.js';

describe('Skill impact (e2e)', () => {
  let app: INestApplication<App>;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let projectId: string;
  const skill = (hash: string) => ({ name: 'pnpm-first', hash, managedBy: 'gildeboek@v1' });

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);

    const ds = app.get(DataSource);
    const project = await ds.getRepository(Project).save({ slug: `impact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: 'Impact' });
    projectId = project.id;
    const repo = await ds.getRepository(Repo).save({ projectId, fullName: `o/impact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, testCommands: ['t'] });
    const seed = async (status: Job['status'], hash: string | null, day: number) => {
      const job = await ds.getRepository(Job).save({ projectId, repoId: repo.id, title: 'T', task: 'x', status, queuedAt: new Date(), attempts: 1 });
      await ds.getRepository(JobRun).save({
        jobId: job.id, projectId, repoId: repo.id, attempt: 1, status: 'fired',
        context: { gildeboekVersion: 'v1', skills: hash ? [skill(hash)] : [], agentsMdHash: null, capturedAt: new Date().toISOString() },
        createdAt: new Date(Date.now() - day * 86_400_000),
      });
    };
    for (let i = 0; i < 10; i++) await seed('merged', 'v-one', 3);
    for (let i = 0; i < 3; i++) await seed('rejected', 'v-two', 1);
    for (let i = 0; i < 4; i++) await seed('merged', null, 2);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns versions with descriptive groups, a timeline and insufficient markers below the minimum', async () => {
    const res = await http.get(`/api/v1/projects/${projectId}/skills/impact`).expect(200);
    expect(res.body).toMatchObject({ days: 30, minRuns: 10 });
    expect(res.body.skills).toHaveLength(1);
    const [one, two] = res.body.skills[0].versions;
    expect(res.body.skills[0].name).toBe('pnpm-first');
    expect([one.hash, two.hash]).toEqual(['v-one', 'v-two']);
    expect(one.with).toMatchObject({ n: 10, insufficient: false });
    expect(one.with.rates.merged).toBe(1);
    expect(one.without).toMatchObject({ n: 4, insufficient: true, rates: null });
    expect(two.with).toMatchObject({ n: 3, insufficient: true, rates: null, counts: { rejectedOrParked: 3 } });
  });

  it('honours the days window', async () => {
    const res = await http.get(`/api/v1/projects/${projectId}/skills/impact?days=1`).expect(200);
    expect(res.body.days).toBe(1);
    expect(res.body.skills).toEqual([]);
  });

  it('rejects days out of range, a bad project id and an unknown project', async () => {
    await http.get(`/api/v1/projects/${projectId}/skills/impact?days=181`).expect(400);
    await http.get(`/api/v1/projects/${projectId}/skills/impact?days=0`).expect(400);
    await http.get('/api/v1/projects/not-a-uuid/skills/impact').expect(400);
    await http.get('/api/v1/projects/00000000-0000-4000-8000-000000000000/skills/impact').expect(404);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get(`/api/v1/projects/${projectId}/skills/impact`).expect(401);
  });
});
