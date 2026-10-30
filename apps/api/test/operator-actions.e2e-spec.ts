import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Repository } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { GITHUB_PORT } from './../src/github/github.port.js';
import { Job } from './../src/job/job.entity.js';
import { Notification } from './../src/notification/notification.entity.js';
import { JobRun } from './../src/run/run.entity.js';
import { authedAgent, createApiKey, createTestUser, tokenFor } from './helpers/auth.js';

const SECRET = 'operator-actions-secret';

describe('Operator actions (e2e)', () => {
  let app: INestApplication;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  const repo = <T extends object>(e: new () => T) => app.get<Repository<T>>(getRepositoryToken(e), { strict: false });

  beforeAll(async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(GITHUB_PORT).useValue({ isConfigured: () => false }).compile())
      .createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();
    http = await authedAgent(app);
  });
  afterAll(async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    await app.close();
  });

  const deliver = (payload: object) => {
    const body = JSON.stringify(payload);
    return request(app.getHttpServer())
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`)
      .send(body);
  };

  const actions = [
    { kind: 'env', when: 'before_deploy', instruction: 'Generate a key with openssl rand -hex 32', name: 'SOME_KEY', where: 'apiEnv' },
    { kind: 'cli', when: 'after_deploy', instruction: 'Run the backfill', required: false },
  ];

  async function openPr(list: unknown) {
    const slug = `oa-${randomUUID().slice(0, 8)}`;
    const project = (await http.post('/api/v1/projects').send({ slug, name: 'OA' }).expect(201)).body;
    const created = (await http.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
    const job = (await http.post(`/api/v1/repos/${created.id}/jobs`).send({ title: 'Add a thing', task: 'Add the thing to the API.' }).expect(201)).body;
    await repo(Job).update({ id: job.id }, { status: 'dispatched', attempts: 1 });
    const run = await repo(JobRun).save(repo(JobRun).create({ jobId: job.id, projectId: project.id, repoId: created.id, attempt: 1, status: 'fired' }));
    const body = [`gilde-job: ${job.id}`, `gilde-run: ${run.id}`, '```gilde-result',
      JSON.stringify({ outcome: 'done', summary: 'ok', operatorActions: list }), '```'].join('\n');
    const pr = (merged: boolean, state = 'open') => ({
      action: merged ? 'closed' : 'opened', number: 7, repository: { full_name: `o/${slug}` },
      pull_request: { number: 7, html_url: `https://github.com/o/${slug}/pull/7`, state, merged, body, head: { ref: 'b', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }, base: { ref: 'main' } },
    });
    await deliver(pr(false)).expect(200);
    return { job, run, merge: () => deliver(pr(true, 'closed')).expect(200) };
  }

  it('exposes the actions on the job, marks them done as a verified human and notifies once on merge', async () => {
    const { job, merge } = await openPr(actions);

    let read = (await http.get(`/api/v1/jobs/${job.id}`).expect(200)).body;
    expect(read.status).toBe('pr_open');
    expect(read.needsOperatorAction).toBe(true);
    expect(read.operatorActions).toEqual([
      { ...actions[0], required: true, doneAt: null, doneById: null },
      { kind: 'cli', when: 'after_deploy', instruction: 'Run the backfill', name: null, where: null, required: false, doneAt: null, doneById: null },
    ]);
    expect(read.runs[0].operatorActions).toHaveLength(2);
    const listed = (await http.get(`/api/v1/jobs?projectId=${job.projectId}`).expect(200)).body;
    expect(listed[0]).toMatchObject({ id: job.id, needsOperatorAction: true });

    // Only verified humans: anonymous and API keys are refused.
    const url = `/api/v1/jobs/${job.id}/operator-actions/0/done`;
    await request(app.getHttpServer()).post(url).expect(401);
    const user = await createTestUser(app);
    const key = await createApiKey(app, user);
    await request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${key}`).expect(401);
    await http.post(`/api/v1/jobs/${job.id}/operator-actions/5/done`).expect(404);
    await http.post(`/api/v1/jobs/${randomUUID()}/operator-actions/0/done`).expect(404);

    const human = await createTestUser(app);
    const as = (u: typeof human) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
    const first = (await request(app.getHttpServer()).post(url).set(as(human)).expect(200)).body;
    expect(first.status).toBe('pr_open');
    expect(first.operatorActions[0]).toMatchObject({ doneById: human.id });
    expect(first.operatorActions[0].doneAt).toEqual(expect.any(String));
    expect(first.needsOperatorAction).toBe(true);

    // A second mark keeps the audit of the first.
    const other = await createTestUser(app);
    const again = (await request(app.getHttpServer()).post(url).set(as(other)).expect(200)).body;
    expect(again.operatorActions[0]).toMatchObject({ doneById: human.id, doneAt: first.operatorActions[0].doneAt });

    await merge();
    await merge();
    const rows = await repo(Notification).findBy({ kind: 'operator.actions', jobId: job.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain('Before deploy: SOME_KEY');
    expect(rows[0].reason).toContain('After deploy: cli (optional): Run the backfill');

    await request(app.getHttpServer()).post(`/api/v1/jobs/${job.id}/operator-actions/1/done`).set(as(human)).expect(200);
    read = (await http.get(`/api/v1/jobs/${job.id}`).expect(200)).body;
    expect(read).toMatchObject({ status: 'merged', needsOperatorAction: false });
  });

  it('keeps the result and drops the actions when one is invalid or looks like a secret', async () => {
    const { job, run } = await openPr([{ kind: 'env', when: 'before_deploy', instruction: 'Set it to sk-abc123' }]);
    const read = (await http.get(`/api/v1/jobs/${job.id}`).expect(200)).body;
    expect(read).toMatchObject({ needsOperatorAction: false, operatorActions: [] });
    expect(read.runs[0].result).toMatchObject({ outcome: 'done', summary: 'ok' });
    expect((await repo(JobRun).findOneByOrFail({ id: run.id })).resultError).toContain('looks like a secret');
  });
});
