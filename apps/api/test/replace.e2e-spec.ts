import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { authedAgent } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';
import { Job } from './../src/job/job.entity.js';
import { Feature } from './../src/feature/feature.entity.js';
import { Lesson } from './../src/lesson/lesson.entity.js';

type Body = Record<string, unknown>;
const NIL = '00000000-0000-4000-8000-000000000000';

describe('Full-replacement PUT updates (e2e)', () => {
  let app: INestApplication<App>;
  let http: Awaited<ReturnType<typeof authedAgent>>;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  const slug = () => `put-${randomUUID().slice(0, 8)}`;
  const makeProject = async () => (await http.post('/api/v1/projects').send({ slug: slug(), name: 'Put project' }).expect(201)).body;
  const makeRepo = async (projectId: string) => (await http.post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug()}` }).expect(201)).body;
  const makeJob = async (repoId: string, extra: Body = {}) =>
    (await http.post(`/api/v1/repos/${repoId}/jobs`).send({ title: 'A job title', task: 'Do the thing please', acceptanceCriteria: ['It works'], status: 'triage', ...extra }).expect(201)).body;
  const makeFeature = async (projectId: string) =>
    (await http.post(`/api/v1/projects/${projectId}/features`).send({ title: 'A feature', spec: 'Spec', acceptanceCriteria: ['Done'] }).expect(201)).body;

  /** Every key of `full` missing in turn must fail with a zod issue on that path. */
  async function expectEachKeyRequired(url: string, full: Body): Promise<void> {
    for (const key of Object.keys(full)) {
      const { [key]: _omitted, ...rest } = full;
      const res = await http.put(url).send(rest).expect(400);
      expect(res.body.issues, key).toEqual(expect.arrayContaining([expect.objectContaining({ path: key })]));
    }
    await http.put(url).send({}).expect(400);
  }

  describe('jobs', () => {
    it('replaces content and feature, clears the feature with null, requires every key', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const feature = await makeFeature(project.id);
      const job = await makeJob(repo.id);
      const url = `/api/v1/jobs/${job.id}`;
      const full = { title: 'Edited title', task: 'Edited task text', acceptanceCriteria: ['One', 'Two'], featureId: feature.id };

      const res = (await http.put(url).send(full).expect(200)).body;
      expect(res).toMatchObject({ ...full, status: 'triage', repoId: repo.id });
      expect((await http.put(url).send({ ...full, acceptanceCriteria: [], featureId: null }).expect(200)).body).toMatchObject({ acceptanceCriteria: [], featureId: null });
      await expectEachKeyRequired(url, full);
    });

    it('keeps the original validation and ignores immutable fields', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const job = await makeJob(repo.id);
      const url = `/api/v1/jobs/${job.id}`;
      const full = { title: 'Edited title', task: 'Edited task text', acceptanceCriteria: ['One'], featureId: null };
      for (const bad of [{ title: 'ab' }, { title: 'x'.repeat(201) }, { task: 'short' }, { acceptanceCriteria: ['ab'] }, { acceptanceCriteria: Array(21).fill('abc') }, { featureId: 'nope' }, { featureId: undefined }]) {
        await http.put(url).send({ ...full, ...bad }).expect(400);
      }
      const res = (await http.put(url).send({ ...full, status: 'merged', repoId: NIL, projectId: NIL, prNumber: 5, attempts: 9, dependsOn: [NIL] }).expect(200)).body;
      expect(res).toMatchObject({ status: 'triage', repoId: repo.id, projectId: project.id, prNumber: null, attempts: 0 });
      await http.patch(url).send({ title: 'Patched title' }).expect(404);
      await http.put(`/api/v1/jobs/${NIL}`).send(full).expect(404);
    });

    it('applies the state rules to a full body: queued takes the feature only, unchanged content is not an edit', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const feature = await makeFeature(project.id);
      await http.post(`/api/v1/features/${feature.id}/start`).expect(200);
      const job = await makeJob(repo.id);
      const url = `/api/v1/jobs/${job.id}`;
      const same = { title: job.title, task: job.task, acceptanceCriteria: job.acceptanceCriteria };
      await http.post(`${url}/enqueue`).expect(200);

      expect((await http.put(url).send({ ...same, featureId: feature.id }).expect(200)).body).toMatchObject({ status: 'queued', featureId: feature.id });
      expect((await http.put(url).send({ ...same, featureId: null }).expect(200)).body).toMatchObject({ featureId: null });
      await http.put(url).send({ ...same, title: 'Changed title', featureId: null }).expect(409);
      await http.put(url).send({ ...same, acceptanceCriteria: ['Changed'], featureId: null }).expect(409);

      await app.get(DataSource).getRepository(Job).update({ id: job.id }, { status: 'dispatched' });
      await http.put(url).send({ ...same, featureId: null }).expect(409);
      await http.put(url).send({ ...same, featureId: feature.id }).expect(409);
    });

    it('validates feature links: unknown 400, other project 400, closed or draft-on-queued 409, unchanged link not rechecked', async () => {
      const project = await makeProject();
      const other = await makeProject();
      const repo = await makeRepo(project.id);
      const job = await makeJob(repo.id);
      const url = `/api/v1/jobs/${job.id}`;
      const body = { title: job.title, task: job.task, acceptanceCriteria: job.acceptanceCriteria };
      await http.put(url).send({ ...body, featureId: NIL }).expect(400);
      await http.put(url).send({ ...body, featureId: (await makeFeature(other.id)).id }).expect(400);

      const feature = await makeFeature(project.id);
      await http.put(url).send({ ...body, featureId: feature.id }).expect(200);
      await app.get(DataSource).getRepository(Feature).update({ id: feature.id }, { status: 'done' });
      // The link is unchanged, so editing the content still works; moving to another closed feature does not.
      await http.put(url).send({ ...body, title: 'Edited while closed', featureId: feature.id }).expect(200);
      const closed = await makeFeature(project.id);
      await app.get(DataSource).getRepository(Feature).update({ id: closed.id }, { status: 'cancelled' });
      await http.put(url).send({ ...body, featureId: closed.id }).expect(409);

      const draft = await makeFeature(project.id);
      const queued = await makeJob(repo.id);
      await http.post(`/api/v1/jobs/${queued.id}/enqueue`).expect(200);
      await http.put(`/api/v1/jobs/${queued.id}`).send({ title: queued.title, task: queued.task, acceptanceCriteria: queued.acceptanceCriteria, featureId: draft.id }).expect(409);
    });

    it('leaves the dependency endpoint unchanged', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const a = await makeJob(repo.id);
      const b = await makeJob(repo.id);
      const res = (await http.put(`/api/v1/jobs/${b.id}/dependencies`).send({ dependsOn: [a.id] }).expect(200)).body;
      expect(res.dependsOn).toEqual([a.id]);
      await http.put(`/api/v1/jobs/${b.id}/dependencies`).send({}).expect(400);
    });
  });

  describe('features', () => {
    it('replaces title, spec and criteria; empty values stay empty; requires every key', async () => {
      const project = await makeProject();
      const feature = await makeFeature(project.id);
      const url = `/api/v1/features/${feature.id}`;
      const full = { title: 'Renamed feature', spec: 'New spec', acceptanceCriteria: ['AAA', 'BBB', 'CCC'] };
      expect((await http.put(url).send(full).expect(200)).body).toMatchObject(full);
      expect((await http.put(url).send({ ...full, spec: '', acceptanceCriteria: [] }).expect(200)).body).toMatchObject({ spec: '', acceptanceCriteria: [] });
      await expectEachKeyRequired(url, full);
      for (const bad of [{ title: 'ab' }, { spec: 'x'.repeat(20001) }, { acceptanceCriteria: ['ab'] }, { spec: null }]) {
        await http.put(url).send({ ...full, ...bad }).expect(400);
      }
      const ignored = (await http.put(url).send({ ...full, status: 'done', projectId: NIL }).expect(200)).body;
      expect(ignored).toMatchObject({ status: 'draft', projectId: project.id });
      await http.patch(url).send({ title: 'Patched' }).expect(404);
      await http.put(`/api/v1/features/${NIL}`).send(full).expect(404);
    });

    it('refuses a closed feature', async () => {
      const project = await makeProject();
      const feature = await makeFeature(project.id);
      await app.get(DataSource).getRepository(Feature).update({ id: feature.id }, { status: 'done' });
      await http.put(`/api/v1/features/${feature.id}`).send({ title: 'Renamed feature', spec: 's', acceptanceCriteria: [] }).expect(409);
    });
  });

  describe('projects', () => {
    const fullOf = (p: Body): Body => ({
      name: p.name, description: p.description, dailyRunLimit: p.dailyRunLimit, maxAttempts: p.maxAttempts,
      runTimeoutMinutes: p.runTimeoutMinutes, retryOnChangesRequested: p.retryOnChangesRequested, autoFixConflicts: p.autoFixConflicts, autoPlan: p.autoPlan,
      skillsLibrary: p.skillsLibrary, skillsLibraryRepoId: p.skillsLibraryRepoId,
      dailyBudgetUsd: p.dailyBudgetUsd, weeklyBudgetUsd: p.weeklyBudgetUsd, budgetSoftPct: p.budgetSoftPct,
    });

    it('replaces every setting, clears nullable ones, requires every key', async () => {
      const project = await makeProject();
      const url = `/api/v1/projects/${project.id}`;
      const full = fullOf(project);
      const edited = { ...full, name: 'Renamed', description: 'Words', dailyRunLimit: 7, maxAttempts: 2, runTimeoutMinutes: 30, retryOnChangesRequested: !project.retryOnChangesRequested, autoFixConflicts: !project.autoFixConflicts, dailyBudgetUsd: 0, weeklyBudgetUsd: 12.5, budgetSoftPct: 60 };
      expect((await http.put(url).send(edited).expect(200)).body).toMatchObject(edited);
      const cleared = { ...edited, description: null, dailyBudgetUsd: null, weeklyBudgetUsd: null };
      expect((await http.put(url).send(cleared).expect(200)).body).toMatchObject({ description: null, dailyBudgetUsd: null, weeklyBudgetUsd: null, dailyRunLimit: 7 });
      await expectEachKeyRequired(url, full);
    });

    it('keeps the original validation, the immutable slug and paused, and the library rules', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const foreign = await makeRepo((await makeProject()).id);
      const url = `/api/v1/projects/${project.id}`;
      const full = fullOf(project);
      for (const bad of [{ name: '' }, { description: 'x'.repeat(2001) }, { dailyRunLimit: 0 }, { maxAttempts: 11 }, { runTimeoutMinutes: 4 }, { retryOnChangesRequested: 'yes' }, { autoFixConflicts: 'yes' }, { skillsLibrary: 'bogus' }, { dailyBudgetUsd: -1 }, { weeklyBudgetUsd: 'x' }, { budgetSoftPct: 0 }, { budgetSoftPct: 100.5 }, { budgetSoftPct: null }]) {
        await http.put(url).send({ ...full, ...bad }).expect(400);
      }
      await http.post(`${url}/pause`).expect(200);
      const res = (await http.put(url).send({ ...full, slug: 'hijacked', paused: false }).expect(200)).body;
      expect(res).toMatchObject({ slug: project.slug, paused: true });
      await http.post(`${url}/resume`).expect(200);

      await http.put(url).send({ ...full, skillsLibrary: 'repo', skillsLibraryRepoId: null }).expect(400);
      await http.put(url).send({ ...full, skillsLibrary: 'repo', skillsLibraryRepoId: foreign.id }).expect(400);
      expect((await http.put(url).send({ ...full, skillsLibrary: 'repo', skillsLibraryRepoId: repo.id }).expect(200)).body).toMatchObject({ skillsLibrary: 'repo', skillsLibraryRepoId: repo.id });
      expect((await http.put(url).send({ ...full, skillsLibrary: 'folder', skillsLibraryRepoId: repo.id }).expect(200)).body).toMatchObject({ skillsLibrary: 'folder', skillsLibraryRepoId: null });
      await http.patch(url).send({ name: 'Patched' }).expect(404);
      await http.put(`/api/v1/projects/${NIL}`).send(full).expect(404);
    });
  });

  describe('repos', () => {
    it('replaces the settings, clears nullable ones, requires every key and keeps fullName', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const url = `/api/v1/repos/${repo.id}`;
      const full = { defaultBranch: 'develop', maxConcurrentJobs: 3 };
      expect((await http.put(url).send(full).expect(200)).body).toMatchObject(full);
      await expectEachKeyRequired(url, full);
      for (const bad of [{ defaultBranch: '' }, { maxConcurrentJobs: 0 }, { maxConcurrentJobs: 11 }, { routineFireUrl: 'not a url' }, { routineTokenEnv: 'lower' }]) {
        await http.put(url).send({ ...full, ...bad }).expect(400);
      }
      // The repo-level routine settings are deprecated: still accepted, never changed.
      const legacy = (await http.put(url).send({ ...full, routineFireUrl: 'https://example.com/fire', routineTokenEnv: 'ROUTINE_TOKEN_X' }).expect(200)).body;
      expect(legacy).toMatchObject({ ...full, routineFireUrl: null, routineTokenEnv: null });
      const res = (await http.put(url).send({ ...full, fullName: 'x/changed', paused: true, projectId: NIL }).expect(200)).body;
      expect(res).toMatchObject({ fullName: repo.fullName, paused: false, projectId: project.id });
      await http.patch(url).send({ defaultBranch: 'patched' }).expect(404);
      await http.put(`/api/v1/repos/${NIL}`).send(full).expect(404);
    });
  });

  describe('lessons', () => {
    async function seedLesson(projectId: string, over: Partial<Lesson> = {}): Promise<Lesson> {
      return app.get(DataSource).getRepository(Lesson).save(Object.assign(new Lesson(), { projectId, text: 'Original lesson', status: 'candidate', ...over }));
    }

    it('replaces the editable fields, clears with null, requires every key', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const lesson = await seedLesson(project.id);
      const url = `/api/v1/lessons/${lesson.id}`;
      const full = { text: 'Edited lesson', targetKind: 'agents_md', targetRepoId: repo.id, note: 'a note' };
      expect((await http.put(url).send(full).expect(200)).body).toMatchObject({ ...full, status: 'candidate', projectId: project.id });
      const cleared = (await http.put(url).send({ ...full, targetKind: null, targetRepoId: null, note: null }).expect(200)).body;
      expect(cleared).toMatchObject({ text: 'Edited lesson', targetKind: null, targetRepoId: null, note: null });
      await expectEachKeyRequired(url, full);
    });

    it('keeps validation: target kinds, repo membership, text limits', async () => {
      const project = await makeProject();
      const foreign = await makeRepo((await makeProject()).id);
      const lesson = await seedLesson(project.id);
      const url = `/api/v1/lessons/${lesson.id}`;
      const full = { text: 'Edited lesson', targetKind: null, targetRepoId: null, note: null };
      for (const bad of [{ text: '' }, { text: 'x'.repeat(10_001) }, { targetKind: 'skill' }, { targetKind: 'bogus' }, { targetRepoId: 'nope' }, { note: 'x'.repeat(10_001) }]) {
        await http.put(url).send({ ...full, ...bad }).expect(400);
      }
      await http.put(url).send({ ...full, targetRepoId: foreign.id }).expect(400);
      await http.put(url).send({ ...full, status: 'applied', projectId: NIL }).expect(200);
      expect((await http.get(url).expect(200)).body).toMatchObject({ status: 'candidate', projectId: project.id });
      await http.patch(url).send({ text: 'Patched' }).expect(404);
      await http.put(`/api/v1/lessons/${NIL}`).send(full).expect(404);
    });
  });

  describe('send-back', () => {
    it('answers 404 for an unknown job and 409 for a job without a PR', async () => {
      const project = await makeProject();
      const repo = await makeRepo(project.id);
      const job = await makeJob(repo.id);
      await http.post(`/api/v1/jobs/${NIL}/send-back`).send({ reason: 'nope' }).expect(404);
      await http.post(`/api/v1/jobs/${job.id}/send-back`).send({ reason: 'nope' }).expect(409);
      await http.post(`/api/v1/jobs/${job.id}/send-back`).send({}).expect(400);
    });
  });
});
