import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { randomUUID, createHash } from 'node:crypto';
import { In, IsNull, type Repository } from 'typeorm';

import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { ApiKeyService } from './../src/api-key/api-key.service.js';
import { AppModule } from './../src/app.module.js';
import { Job } from './../src/job/job.entity.js';
import { JobDependency } from './../src/job/job-dependency.entity.js';
import { JobService } from './../src/job/job.service.js';
import { SpecApproval } from './../src/spec/spec-approval.entity.js';
import { SpecRecording } from './../src/spec/spec-recording.entity.js';
import { SpecService } from './../src/spec/spec.service.js';
import { SpecVersion } from './../src/spec/spec-version.entity.js';
import { UserService } from './../src/user/user.service.js';

const body = (over: Partial<Record<string, string>> = {}) => {
  const sections: Record<string, string> = {
    Goal: 'Ship it.', Context: 'Why.', Behaviour: 'How.',
    'Acceptance criteria': '- AC-1: First\n- AC-2: Second',
    'Out of scope': 'Nothing.', 'Open questions': 'None', ...over,
  };
  return Object.entries(sections).map(([h, t]) => `## ${h}\n\n${t}\n`).join('\n');
};

describe('Specs (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let projectId: string;
  let repoId: string;
  const as = (u: TestUser) => request.agent(app.getHttpServer()).set({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const jobs = () => app.get<Repository<Job>>(getRepositoryToken(Job));
  const edges = () => app.get<Repository<JobDependency>>(getRepositoryToken(JobDependency));
  const recordings = () => app.get<Repository<SpecRecording>>(getRepositoryToken(SpecRecording));
  const approvals = () => app.get<Repository<SpecApproval>>(getRepositoryToken(SpecApproval));
  const versions = () => app.get<Repository<SpecVersion>>(getRepositoryToken(SpecVersion));
  const slugN = () => `s-${randomUUID().slice(0, 8)}`;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.listen(0);
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = `sp-${randomUUID().slice(0, 8)}`;
    projectId = (await as(ann).post('/api/v1/projects').send({ slug, name: 'Spec project' }).expect(201)).body.id;
    repoId = (await as(ann).post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createSpec = async (text = body(), slug = slugN()) =>
    (await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug, title: 'A spec', body: text, expectedVersion: 0 }).expect(201)).body;
  const save = (id: string, text: string, expectedVersion: number, u = ann) =>
    as(u).post(`/api/v1/specs/${id}/versions`).send({ title: 'A spec', body: text, expectedVersion });
  const approve = (id: string, expectedVersion: number, u = ann) => as(u).post(`/api/v1/specs/${id}/approve`).send({ expectedVersion });
  const detail = async (id: string) => (await as(ann).get(`/api/v1/specs/${id}`).expect(200)).body;
  const specJobs = async () => jobs().find({ where: { repoId } });

  describe('creating and reading', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get(`/api/v1/projects/${projectId}/specs`).expect(401);
      await request(app.getHttpServer()).post(`/api/v1/specs/${randomUUID()}/approve`).send({ expectedVersion: 1 }).expect(401);
    });

    it('creates version 1 as a draft with parsed criteria, and lists it', async () => {
      const spec = await createSpec();
      expect(spec).toMatchObject({ projectId, repoId, status: 'draft', currentVersion: 1, approvedVersion: null, createdById: ann.id, updatedById: ann.id });
      expect(spec.versions).toHaveLength(1);
      expect(spec.versions[0]).toMatchObject({
        version: 1, criteria: [{ number: 1, id: 'AC-1', text: 'First' }, { number: 2, id: 'AC-2', text: 'Second' }],
        eligibility: { eligible: true, reasons: [] }, approval: null, recording: null,
      });
      const list = (await as(ann).get(`/api/v1/projects/${projectId}/specs`).expect(200)).body;
      expect(list.map((s: { id: string }) => s.id)).toEqual([spec.id]);
      expect(list[0]).not.toHaveProperty('versions');
      await as(ann).get(`/api/v1/specs/${randomUUID()}`).expect(404);
      await as(ann).get(`/api/v1/projects/${randomUUID()}/specs`).expect(404);
    });

    it('stores the body byte for byte (whitespace, CRLF, unicode, no trailing newline)', async () => {
      const odd = `${body().replace(/\n/g, '\r\n')}  \t\r\n\r\n\n✓ héllo`;
      const spec = await createSpec(odd);
      const stored = await versions().findOneByOrFail({ specId: spec.id, version: 1 });
      expect(stored.body).toBe(odd);
      expect(spec.versions[0].body).toBe(odd);
      expect(spec.versions[0].bodySha256).toBe(createHash('sha256').update(odd, 'utf8').digest('hex'));
    });

    it('rejects a repo from another project and unknown repos', async () => {
      const other = (await as(ann).post('/api/v1/projects').send({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' }).expect(201)).body.id;
      await as(ann).post(`/api/v1/projects/${other}/specs`).send({ repoId, slug: slugN(), title: 'A spec', body: body(), expectedVersion: 0 }).expect(400);
      await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId: randomUUID(), slug: slugN(), title: 'A spec', body: body(), expectedVersion: 0 }).expect(404);
      await as(ann).post(`/api/v1/projects/${randomUUID()}/specs`).send({ repoId, slug: slugN(), title: 'A spec', body: body(), expectedVersion: 0 }).expect(404);
    });

    it('enforces a unique kebab-case slug per repo and a template-conforming body', async () => {
      const slug = slugN();
      await createSpec(body(), slug);
      await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug, title: 'A spec', body: body(), expectedVersion: 0 }).expect(409);
      for (const bad of ['Bad_Slug', 'UPPER', 'a--b', '-a', 'a-', '']) {
        await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: bad, title: 'A spec', body: body(), expectedVersion: 0 }).expect(400);
      }
      const res = await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: slugN(), title: 'A spec', body: '## Goal\n\nx\n', expectedVersion: 0 }).expect(400);
      expect(JSON.stringify(res.body.issues)).toContain('Missing H2 heading');
    });

    it('requires expectedVersion 0 on create', async () => {
      await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: slugN(), title: 'A spec', body: body(), expectedVersion: 3 }).expect(409);
      await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: slugN(), title: 'A spec', body: body() }).expect(400);
    });

    it('takes the actor from the request only: actor fields in the body are rejected', async () => {
      const bob = await createTestUser(app, { name: 'Bob' });
      for (const field of [{ createdBy: bob.id }, { actor: bob.id }, { createdById: bob.id }, { updatedBy: bob.id }]) {
        await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: slugN(), title: 'A spec', body: body(), expectedVersion: 0, ...field }).expect(400);
      }
      const spec = await createSpec();
      await as(ann).post(`/api/v1/specs/${spec.id}/versions`).send({ title: 'A spec', body: body(), expectedVersion: 1, updatedBy: bob.id }).expect(400);
      await as(ann).post(`/api/v1/specs/${spec.id}/approve`).send({ expectedVersion: 1, approvedBy: bob.id }).expect(400);
      const saved = (await save(spec.id, body({ Goal: 'Changed' }), 1, bob).expect(201)).body;
      expect(saved.updatedById).toBe(bob.id);
      expect(saved.versions[0].createdById).toBe(bob.id);
      expect(saved.createdById).toBe(ann.id);
    });
  });

  describe('versions', () => {
    it('inserts immutable versions, returns to draft, and keeps old approval evidence', async () => {
      const spec = await createSpec();
      const first = (await approve(spec.id, 1).expect(200)).body;
      expect(first).toMatchObject({ status: 'approved', approvedVersion: 1, approvedById: ann.id });
      const evidence = first.versions[0].approval;
      expect(evidence).toMatchObject({ approvedById: ann.id, approvedByName: 'Ann', approvedByEmail: ann.email });

      const v2 = body({ Goal: 'A different goal' });
      const next = (await save(spec.id, v2, 1).expect(201)).body;
      expect(next).toMatchObject({ status: 'draft', currentVersion: 2, approvedVersion: 1 });
      expect(next.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(next.versions[1].approval).toEqual(evidence);
      expect(next.versions[1].body).toBe(body());
      expect(next.versions[0].approval).toBeNull();
      expect((await versions().findOneByOrFail({ specId: spec.id, version: 1 })).body).toBe(body());
    });

    it('returns 409 for a stale expectedVersion and writes nothing', async () => {
      const spec = await createSpec();
      await save(spec.id, body({ Goal: 'v2' }), 1).expect(201);
      const stale = await save(spec.id, body({ Goal: 'v2 again' }), 1).expect(409);
      expect(stale.body.currentVersion).toBe(2);
      await approve(spec.id, 1).expect(409);
      await approve(spec.id, 3).expect(409);
      expect(await versions().count({ where: { specId: spec.id } })).toBe(2);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(0);
      expect((await detail(spec.id)).status).toBe('draft');
    });

    it('lets two concurrent saves at the same version produce exactly one new version', async () => {
      const spec = await createSpec();
      const results = await Promise.all([save(spec.id, body({ Goal: 'one' }), 1), save(spec.id, body({ Goal: 'two' }), 1)]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
      expect(await versions().count({ where: { specId: spec.id } })).toBe(2);
    });

    it('never renumbers criteria: retired ids cannot return and new ids exceed the historical maximum', async () => {
      const spec = await createSpec(body({ 'Acceptance criteria': '- AC-1: a\n- AC-2: b\n- AC-3: c' }));
      // drop AC-3 (retired) and keep 1, 2
      await save(spec.id, body({ 'Acceptance criteria': '- AC-1: a\n- AC-2: b' }), 1).expect(201);
      // AC-3 may not come back
      const back = await save(spec.id, body({ 'Acceptance criteria': '- AC-1: a\n- AC-2: b\n- AC-3: c' }), 2).expect(400);
      expect(JSON.stringify(back.body.issues)).toContain('AC-3 was retired');
      // the next new id is above the historical max, even though latest max is 2
      await save(spec.id, body({ 'Acceptance criteria': '- AC-1: a\n- AC-2: b\n- AC-3b: x' }), 2).expect(400);
      const reused = await save(spec.id, body({ 'Acceptance criteria': '- AC-1: a\n- AC-2: b' }), 2).expect(201);
      expect(reused.body.currentVersion).toBe(3);
      await save(spec.id, body({ 'Acceptance criteria': '- AC-1: a\n- AC-2: b\n- AC-4: new' }), 3).expect(201);
      // renumbering: AC-1 retired and AC-2 shifted down is refused
      const spec2 = await createSpec(body({ 'Acceptance criteria': '- AC-1: a\n- AC-2: b' }));
      const renumbered = await save(spec2.id, body({ 'Acceptance criteria': '- AC-1: b' }), 1).expect(201);
      expect(renumbered.body.versions[0].criteria).toEqual([{ number: 1, id: 'AC-1', text: 'b' }]);
      await save(spec2.id, body({ 'Acceptance criteria': '- AC-2: b' }), 2).expect(400);
    });
  });

  describe('approval permissions and eligibility', () => {
    it('reports mayApprove per caller: verified human, bot and API key', async () => {
      const spec = await createSpec();
      const bot = await createTestUser(app, { name: 'Bot' });
      await app.get(UserService).markBot(bot.email);
      const { key } = await app.get(ApiKeyService).create(ann.id, { name: 'k' });

      expect((await detail(spec.id))).toMatchObject({ mayApprove: true, mayApproveReasons: [] });
      const botView = (await as(bot).get(`/api/v1/specs/${spec.id}`)).body;
      expect(botView).toMatchObject({ mayApprove: false });
      expect(botView.mayApproveReasons.join()).toContain('Bot accounts');
      const keyView = (await request(app.getHttpServer()).get(`/api/v1/specs/${spec.id}`).set({ Authorization: `Bearer ${key}` }).expect(200)).body;
      expect(keyView.mayApprove).toBe(false);
      expect(keyView.mayApproveReasons.join()).toContain('API keys');
    });

    it('refuses bots (403) and API keys, even of a human account, and creates nothing', async () => {
      const spec = await createSpec();
      const bot = await createTestUser(app, { name: 'Bot' });
      await app.get(UserService).markBot(bot.email);
      await approve(spec.id, 1, bot).expect(403);
      const { key } = await app.get(ApiKeyService).create(ann.id, { name: 'k' });
      await request(app.getHttpServer()).post(`/api/v1/specs/${spec.id}/approve`).set({ Authorization: `Bearer ${key}` }).send({ expectedVersion: 1 }).expect(401);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(0);
      expect(await specJobs()).toHaveLength(0);
      expect((await detail(spec.id)).status).toBe('draft');
    });

    it('lets bots and API keys save drafts but not approve', async () => {
      const spec = await createSpec();
      const bot = await createTestUser(app, { name: 'Bot' });
      await app.get(UserService).markBot(bot.email);
      const saved = (await save(spec.id, body({ Goal: 'by bot' }), 1, bot).expect(201)).body;
      expect(saved).toMatchObject({ status: 'draft', approvedVersion: null, updatedById: bot.id });
      const { key } = await app.get(ApiKeyService).create(ann.id, { name: 'k' });
      await request(app.getHttpServer()).post(`/api/v1/specs/${spec.id}/versions`).set({ Authorization: `Bearer ${key}` }).send({ title: 'A spec', body: body({ Goal: 'by key' }), expectedVersion: 2 }).expect(201);
    });

    it('saves a version with open questions but makes it ineligible, with explicit reasons', async () => {
      const spec = await createSpec(body({ 'Open questions': '- Which database?\n- Who owns it?' }));
      const view = await detail(spec.id);
      expect(view.eligibility).toEqual({ eligible: false, reasons: ['Open question: Which database?', 'Open question: Who owns it?'] });
      expect(view.mayApprove).toBe(true);
      const res = await approve(spec.id, 1).expect(422);
      expect(res.body.reasons).toEqual(['Open question: Which database?', 'Open question: Who owns it?']);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(0);
      expect(await specJobs()).toHaveLength(0);
      // resolving them makes the next version approvable
      await save(spec.id, body({ 'Open questions': 'None' }), 1).expect(201);
      await approve(spec.id, 2).expect(200);
    });
  });

  describe('approval and the recording job', () => {
    it('atomically creates one triage recording job owned by the approver with the exact body', async () => {
      const bob = await createTestUser(app, { name: 'Bob' });
      const text = `${body({ 'Out of scope': 'Nothing.  \t' })}  \n`;
      const slug = slugN();
      const spec = await createSpec(text, slug);
      const res = (await approve(spec.id, 1, bob).expect(200)).body;
      expect(res).toMatchObject({ status: 'approved', approvedVersion: 1, approvedById: bob.id });
      const rec = res.versions[0].recording;
      expect(rec).toMatchObject({ state: 'triage', jobStatus: 'triage', jobTitle: `Record spec ${slug} v1`, dependsOnJobId: null, supersededByRecordingId: null });
      const job = await jobs().findOneByOrFail({ id: rec.jobId });
      expect(job).toMatchObject({ status: 'triage', createdById: bob.id, repoId, projectId, title: `Record spec ${slug} v1`, queuedAt: null, attempts: 0 });
      expect(job.task.startsWith('First run `git fetch origin && git rebase origin/')).toBe(true);
      expect(job.task).toContain(spec.id);
      expect(job.task).toContain('Bob <');
      expect(job.task).toContain(res.versions[0].approval.approvedAt);
      const hash = createHash('sha256').update(text, 'utf8').digest('hex');
      expect(job.task).toContain(`\nBEGIN SPEC BODY sha256:${hash}\n${text}\nEND SPEC BODY sha256:${hash}`);
      expect(job.task).toContain(`docs/specs/${slug}.md`);
      expect(job.acceptanceCriteria.join('\n')).toContain(`No file other than docs/specs/${slug}.md and docs/specs/README.md`);
      expect(await specJobs()).toHaveLength(1);
    });

    it('is idempotent for the same version: retries create no duplicate work', async () => {
      const spec = await createSpec();
      const first = (await approve(spec.id, 1).expect(200)).body;
      const again = (await approve(spec.id, 1).expect(200)).body;
      expect(again.versions[0].recording.jobId).toBe(first.versions[0].recording.jobId);
      expect(again.versions[0].approval).toEqual(first.versions[0].approval);
      expect(await specJobs()).toHaveLength(1);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(1);
      expect(await recordings().count({ where: { specId: spec.id } })).toBe(1);
    });

    it('creates exactly one approval and job for concurrent approvals', async () => {
      const spec = await createSpec();
      const bob = await createTestUser(app, { name: 'Bob' });
      const results = await Promise.all([approve(spec.id, 1), approve(spec.id, 1, bob), approve(spec.id, 1), approve(spec.id, 1, bob)]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await specJobs()).toHaveLength(1);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(1);
      expect(new Set(results.map((r) => r.body.versions[0].recording.jobId)).size).toBe(1);
    });

    it('serialises a concurrent save and approve: the approval names the version it saw or is stale', async () => {
      const spec = await createSpec();
      const [a, s] = await Promise.all([approve(spec.id, 1), save(spec.id, body({ Goal: 'racing' }), 1)]);
      expect([a.status, s.status].sort((x, y) => x - y)).not.toEqual([409, 409]);
      const view = await detail(spec.id);
      const approvedV1 = (await approvals().findOneBy({ specId: spec.id, version: 1 })) !== null;
      expect(await specJobs()).toHaveLength(approvedV1 ? 1 : 0);
      if (a.status === 200) expect(view.approvedVersion).toBe(1);
      else expect(view.approvedVersion).toBeNull();
    });
  });

  describe('replacing recordings', () => {
    const approveNext = async (id: string, text: string, from: number, u = ann) => {
      await save(id, text, from, u).expect(201);
      return (await approve(id, from + 1, u).expect(200)).body;
    };

    it('replaces an unstarted triage recording in place and keeps the old evidence', async () => {
      const spec = await createSpec();
      const bob = await createTestUser(app, { name: 'Bob' });
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const jobId = v1.versions[0].recording.jobId;
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1, bob);
      expect(await specJobs()).toHaveLength(1);
      const [rec2, rec1] = v2.versions.map((v: { recording: { jobId: string } }) => v.recording);
      expect(rec2).toMatchObject({ jobId, state: 'triage', jobTitle: expect.stringContaining('v2'), supersededByRecordingId: null });
      expect(rec1).toMatchObject({ jobId, state: 'superseded', supersededByRecordingId: rec2.id });
      expect(rec1.supersededAt).not.toBeNull();
      const job = await jobs().findOneByOrFail({ id: jobId });
      expect(job).toMatchObject({ status: 'triage', createdById: bob.id });
      expect(job.task).toContain('Second');
      expect(job.task).not.toContain('Ship it.');
      // old audit rows were not rewritten
      expect(v2.versions[1].approval.approvedByName).toBe('Ann');
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(2);
    });

    it('cancels a queued unstarted recording through the state machine and replaces it with a triage job', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const oldJob = v1.versions[0].recording.jobId;
      await as(ann).post(`/api/v1/jobs/${oldJob}/enqueue`).expect(200);
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1);
      const [rec2, rec1] = v2.versions.map((v: { recording: { jobId: string } }) => v.recording);
      expect(rec1).toMatchObject({ jobId: oldJob, jobStatus: 'cancelled', state: 'superseded', supersededByRecordingId: rec2.id });
      expect(rec2).toMatchObject({ state: 'triage', jobStatus: 'triage', dependsOnJobId: null });
      expect(rec2.jobId).not.toBe(oldJob);
      expect(await edges().count({ where: { jobId: rec2.jobId } })).toBe(0);
    });

    it.each(['dispatched', 'pr_open', 'awaiting_review'] as const)('never touches %s work: the newer triage recording waits for it', async (status) => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const inFlight = v1.versions[0].recording.jobId;
      await jobs().update({ id: inFlight }, { status, attempts: 1, queuedAt: new Date() });
      const before = await jobs().findOneByOrFail({ id: inFlight });
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1);
      const [rec2, rec1] = v2.versions.map((v: { recording: { jobId: string } }) => v.recording);
      expect(rec1).toMatchObject({ jobId: inFlight, state: 'in_flight', supersededByRecordingId: null });
      expect(rec2).toMatchObject({ state: 'triage', dependsOnJobId: inFlight });
      expect(await jobs().findOneByOrFail({ id: inFlight })).toMatchObject({ status, task: before.task, title: before.title, attempts: 1 });
      const newJob = (await as(ann).get(`/api/v1/jobs/${rec2.jobId}`).expect(200)).body;
      expect(newJob).toMatchObject({ status: 'triage', dependsOn: [inFlight], blockedBy: [{ id: inFlight, status }] });
    });

    it('keeps serial order across three versions: the newest reuses the unstarted tail and keeps its prerequisite', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const first = v1.versions[0].recording.jobId;
      await jobs().update({ id: first }, { status: 'pr_open', attempts: 1 });
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1);
      const second = v2.versions[0].recording.jobId;
      const v3 = await approveNext(spec.id, body({ Goal: 'Third' }), 2);
      const [rec3, rec2, rec1] = v3.versions.map((v: { recording: { jobId: string } }) => v.recording);
      expect(rec3).toMatchObject({ jobId: second, dependsOnJobId: first, state: 'triage' });
      expect(rec2).toMatchObject({ state: 'superseded', supersededByRecordingId: rec3.id });
      expect(rec1.state).toBe('in_flight');
      expect(await specJobs()).toHaveLength(2);
      expect((await edges().find({ where: { jobId: second } })).map((e) => e.dependsOnJobId)).toEqual([first]);
    });

    it.each(['parked', 'rejected', 'cancelled'] as const)('a %s recording stays an explicit blocker: the next one depends on it and is not queued', async (status) => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const failed = v1.versions[0].recording.jobId;
      await jobs().update({ id: failed }, { status });
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1);
      const [rec2, rec1] = v2.versions.map((v: { recording: { jobId: string } }) => v.recording);
      expect(rec1).toMatchObject({ state: 'failed', jobStatus: status, supersededByRecordingId: null });
      expect(rec2).toMatchObject({ state: 'triage', dependsOnJobId: failed });
      const newJob = (await as(ann).get(`/api/v1/jobs/${rec2.jobId}`).expect(200)).body;
      expect(newJob).toMatchObject({ status: 'triage', blockedBy: [{ id: failed, status }] });
      expect((await jobs().findOneByOrFail({ id: failed })).status).toBe(status);
    });

    it('marks a merged-without-work recording failed and waits for it; a clean merge needs no prerequisite', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      await jobs().update({ id: v1.versions[0].recording.jobId }, { status: 'merged', mergedBlocked: true, attempts: 1 });
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1);
      expect(v2.versions[1].recording).toMatchObject({ state: 'failed', mergedWithoutWork: true });
      expect(v2.versions[0].recording.dependsOnJobId).toBe(v1.versions[0].recording.jobId);
      await jobs().update({ id: v2.versions[0].recording.jobId }, { status: 'merged', mergedBlocked: false, attempts: 1 });
      const v3 = await approveNext(spec.id, body({ Goal: 'Third' }), 2);
      expect(v3.versions[1].recording).toMatchObject({ state: 'recorded' });
      expect(v3.versions[0].recording.dependsOnJobId).toBeNull();
    });

    it('does not reuse or cancel a recording that is pinned by a feature', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const pinned = v1.versions[0].recording.jobId;
      await app.get(SpecService).pinRecording(spec.id, 1, randomUUID());
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1);
      expect(v2.versions[1].recording).toMatchObject({ jobId: pinned, state: 'triage', supersededByRecordingId: null });
      expect(v2.versions[1].recording.pinnedByFeatureId).not.toBeNull();
      expect(v2.versions[0].recording).toMatchObject({ dependsOnJobId: pinned });
      expect((await jobs().findOneByOrFail({ id: pinned })).task).toContain('Ship it.');
      await as(ann).post(`/api/v1/jobs/${pinned}/enqueue`).expect(200);
      const v3 = await approveNext(spec.id, body({ Goal: 'Third' }), 2);
      expect((await jobs().findOneByOrFail({ id: pinned })).status).toBe('queued');
      expect(v3.versions[2].recording.state).toBe('queued');
      // a second feature may pin the same version: it stays pinned by the first, which protects it for both
      await expect(app.get(SpecService).pinRecording(spec.id, 1, randomUUID())).resolves.toBeUndefined();
    });

    it('treats a dispatcher that claims the queued job first as in flight', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const queued = v1.versions[0].recording.jobId;
      await as(ann).post(`/api/v1/jobs/${queued}/enqueue`).expect(200);
      const jobService = app.get(JobService);
      const original = jobService.cancelUnstartedQueuedIn.bind(jobService);
      vi.spyOn(jobService, 'cancelUnstartedQueuedIn').mockImplementation(async (m, id) => {
        // the dispatcher claims the job between our read and our conditional write
        await jobs().update({ id, status: 'queued' }, { status: 'dispatched', attempts: 1 });
        return original(m, id);
      });
      const v2 = await approveNext(spec.id, body({ Goal: 'Second' }), 1);
      const [rec2, rec1] = v2.versions.map((v: { recording: { jobId: string } }) => v.recording);
      expect(rec1).toMatchObject({ jobId: queued, jobStatus: 'dispatched', state: 'in_flight' });
      expect(rec2).toMatchObject({ dependsOnJobId: queued, state: 'triage' });
      expect(await specJobs()).toHaveLength(2);
    });

    it('never produces runnable duplicates when approve races the dispatcher claim', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const queued = v1.versions[0].recording.jobId;
      await as(ann).post(`/api/v1/jobs/${queued}/enqueue`).expect(200);
      await save(spec.id, body({ Goal: 'Second' }), 1).expect(201);
      const claim = jobs().update({ id: queued, status: 'queued' }, { status: 'dispatched', attempts: () => 'attempts + 1' });
      const [res] = await Promise.all([approve(spec.id, 2), claim]);
      expect(res.status).toBe(200);
      const all = await specJobs();
      const old = all.find((j) => j.id === queued)!;
      const runnable = all.filter((j) => j.status === 'queued' || j.status === 'dispatched');
      expect(runnable.length).toBeLessThanOrEqual(1);
      const newest = res.body.versions[0].recording;
      if (old.status === 'dispatched') expect(newest).toMatchObject({ dependsOnJobId: queued, jobStatus: 'triage' });
      else expect(old.status).toBe('cancelled');
      expect(all.filter((j) => j.status === 'triage' || j.status === 'queued').every((j) => j.attempts === 0)).toBe(true);
    });
  });

  describe('rollback', () => {
    it('leaves no half-approved state when job creation fails after it wrote', async () => {
      const spec = await createSpec();
      const jobService = app.get(JobService);
      const original = jobService.create.bind(jobService);
      vi.spyOn(jobService, 'create').mockImplementation(async (...args) => {
        await original(...args);
        throw new Error('boom after the job insert');
      });
      await approve(spec.id, 1).expect(500);
      expect(await specJobs()).toHaveLength(0);
      expect(await edges().count({ where: { jobId: In((await jobs().find({ where: { repoId } })).map((j) => j.id)) } })).toBe(0);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(0);
      expect(await recordings().count({ where: { specId: spec.id } })).toBe(0);
      expect(await detail(spec.id)).toMatchObject({ status: 'draft', approvedVersion: null, approvedById: null, approvedAt: null });
      vi.restoreAllMocks();
      await approve(spec.id, 1).expect(200);
      expect(await specJobs()).toHaveLength(1);
    });

    it('restores a cancelled queued recording when creating its replacement fails', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const queued = v1.versions[0].recording.jobId;
      await as(ann).post(`/api/v1/jobs/${queued}/enqueue`).expect(200);
      await save(spec.id, body({ Goal: 'Second' }), 1).expect(201);
      vi.spyOn(app.get(JobService), 'create').mockRejectedValue(new Error('boom'));
      await approve(spec.id, 2).expect(500);
      expect(await jobs().findOneByOrFail({ id: queued })).toMatchObject({ status: 'queued' });
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(1);
      expect(await recordings().count({ where: { specId: spec.id, supersededAt: IsNull() } })).toBe(1);
      const r1 = await recordings().findOneByOrFail({ specId: spec.id, version: 1 });
      expect(r1.supersededAt).toBeNull();
      expect((await detail(spec.id)).approvedVersion).toBe(1);
    });

    it('restores an in-place rewrite when the audit write fails', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      const jobId = v1.versions[0].recording.jobId;
      const before = await jobs().findOneByOrFail({ id: jobId });
      await save(spec.id, body({ Goal: 'Second' }), 1).expect(201);
      const jobService = app.get(JobService);
      const original = jobService.rewriteUnstartedTriageIn.bind(jobService);
      vi.spyOn(jobService, 'rewriteUnstartedTriageIn').mockImplementation(async (...args) => {
        const done = await original(...args);
        throw new Error(`boom after rewrite ${done}`);
      });
      await approve(spec.id, 2).expect(500);
      const after = await jobs().findOneByOrFail({ id: jobId });
      expect(after.task).toBe(before.task);
      expect(after.title).toBe(before.title);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(1);
      expect(await recordings().count({ where: { specId: spec.id } })).toBe(1);
    });

    it('fails dependency validation without leaving a job behind', async () => {
      const spec = await createSpec();
      const v1 = (await approve(spec.id, 1).expect(200)).body;
      await jobs().update({ id: v1.versions[0].recording.jobId }, { status: 'dispatched', attempts: 1 });
      await save(spec.id, body({ Goal: 'Second' }), 1).expect(201);
      vi.spyOn(app.get(JobService), 'validateDependencies').mockRejectedValue(new Error('invalid dependency'));
      await approve(spec.id, 2).expect(500);
      expect(await specJobs()).toHaveLength(1);
      expect(await approvals().count({ where: { specId: spec.id } })).toBe(1);
    });
  });
});
