import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { Repo } from './../src/repo/repo.entity.js';
import { EXECUTION_PORT, type ExecutionPort } from './../src/execution/execution.port.js';
import { prepareJobPrompt } from './../src/execution/job-prompt.js';
import { UserService } from './../src/user/user.service.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

const TOKEN = 'sk-ant-oat01-DISPATCHSECRET-9z9z';

describe('Dispatch on personal executors (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let bob: TestUser;
  let repoId: string;
  let fired: { executorName: string; fireUrl: string; token: string }[];
  const previousKey = process.env.EXECUTOR_SECRET_KEY;
  const http = () => request(app.getHttpServer());
  const as = (u: Pick<TestUser, 'id' | 'email' | 'name'>) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });

  beforeEach(async () => {
    process.env.EXECUTOR_SECRET_KEY = randomBytes(32).toString('base64');
    fired = [];
    const execution: ExecutionPort = {
      prepare: (payload, context) => prepareJobPrompt(payload, { text: null, version: null }, context),
      fire: async (target) => { fired.push(target); return { sessionId: `s-${fired.length}`, sessionUrl: 'https://claude.ai/code/s' }; },
    };
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EXECUTION_PORT).useValue(execution).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
    bob = await createTestUser(app, { name: 'Bob' });
    const slug = randomBytes(4).toString('hex');
    const project = (await http().post('/api/v1/projects').set(as(ann)).send({ name: `P ${slug}`, slug: `p-${slug}` })).body;
    repoId = (await http().post(`/api/v1/projects/${project.id}/repos`).set(as(ann)).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    // A cached manifest, so the repo is dispatchable.
    await app.get(DataSource).getRepository(Repo).update({ id: repoId }, { testCommands: ['pnpm test'], stacks: ['node'], maxConcurrentJobs: 5 });
  });

  afterEach(async () => {
    await app.close();
    if (previousKey === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = previousKey;
  });

  const addExecutor = async (u: TestUser, name: string) =>
    (await http().post('/api/v1/executors').set(as(u)).send({ name, fireUrl: `https://api.anthropic.com/v1/claude_code/routines/${name}/fire`, token: TOKEN, repoIds: [repoId], maxConcurrent: 2 }).expect(201)).body;
  const triageJob = async (u: Pick<TestUser, 'id' | 'email' | 'name'>, title: string) =>
    (await http().post(`/api/v1/repos/${repoId}/jobs`).set(as(u)).send({ title, task: `Do ${title} please`, status: 'triage' }).expect(201)).body;
  /** The report of this test's repo only: the database is shared with other tests and earlier jobs of this file. */
  const dispatch = async () => {
    const result = (await http().post('/api/v1/dispatch').set(as(ann)).expect(201)).body;
    const own = result.repos.find((r: { repoId: string }) => r.repoId === repoId);
    return { fired: own?.fired ?? 0, waitingOnExecutor: own?.waitingOnExecutor ?? 0 };
  };
  const detail = async (id: string) => (await http().get(`/api/v1/jobs/${id}`).set(as(ann)).expect(200)).body;
  const column = async (table: string, col: string, id: string) =>
    (await app.get(DataSource).query(`SELECT ${col} AS v FROM ${table} WHERE id = '${id}'`))[0].v as string | null;

  it('records queued_by_id when a human queues (single and bulk) and exposes the owner', async () => {
    const mine = await triageJob(ann, 'mine');
    expect(mine.ownerId).toBe(ann.id);
    expect(await column('jobs', 'queued_by_id', mine.id)).toBeNull();

    const queued = (await http().post(`/api/v1/jobs/${mine.id}/enqueue`).set(as(bob)).expect(200)).body;
    expect(await column('jobs', 'queued_by_id', mine.id)).toBe(bob.id);
    expect(queued.ownerId).toBe(ann.id); // a human creator stays the owner

    const a = await triageJob(ann, 'bulk a');
    const b = await triageJob(ann, 'bulk b');
    await http().post('/api/v1/jobs/enqueue').set(as(bob)).send({ ids: [a.id, b.id] }).expect(200);
    expect(await column('jobs', 'queued_by_id', a.id)).toBe(bob.id);
    expect(await column('jobs', 'queued_by_id', b.id)).toBe(bob.id);
  });

  it('makes the human who queues a bot-created job its owner, and a bot never becomes one', async () => {
    const bot = await app.get(UserService).create({ name: 'Bot', email: `bot-${randomUUID()}@example.com`, password: 'correct-horse-battery' }, { isBot: true });
    const job = await triageJob(bot, 'from the bot');
    expect(job.ownerId).toBeNull();

    const queued = (await http().post(`/api/v1/jobs/${job.id}/enqueue`).set(as(bot)).expect(200)).body;
    expect(queued.ownerId).toBeNull();
    await http().post(`/api/v1/jobs/${job.id}/triage`).set(as(bot)).expect(200);

    const byBob = (await http().post(`/api/v1/jobs/${job.id}/enqueue`).set(as(bob)).expect(200)).body;
    expect(byBob.ownerId).toBe(bob.id);
  });

  it('fires only on the owner\'s executor, records executor_id and shows name and owner but never the token', async () => {
    const mine = await addExecutor(ann, 'ann-main');
    await addExecutor(bob, 'bob-main');
    const job = await triageJob(ann, 'owned by ann');
    await http().post(`/api/v1/jobs/${job.id}/enqueue`).set(as(ann)).expect(200);

    expect(await dispatch()).toMatchObject({ fired: 1, waitingOnExecutor: 0 });
    expect(fired).toEqual([expect.objectContaining({ executorName: 'ann-main', token: TOKEN })]);

    const d = await detail(job.id);
    expect(d.status).toBe('dispatched');
    expect(d.runs[0]).toMatchObject({ executorId: mine.id, executor: { id: mine.id, name: 'ann-main', ownerId: ann.id, ownerName: 'Ann' } });
    expect(await column('job_runs', 'executor_id', d.runs[0].id)).toBe(mine.id);
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it('keeps a job waiting with a visible reason when its owner has no executor, never using another user\'s', async () => {
    await addExecutor(bob, 'bob-main');
    const job = await triageJob(ann, 'ann without executor');
    await http().post(`/api/v1/jobs/${job.id}/enqueue`).set(as(ann)).expect(200);

    const result = await dispatch();
    expect(result).toMatchObject({ fired: 0, waitingOnExecutor: 1 });
    expect(fired).toEqual([]);
    expect((await http().get('/api/v1/dispatch/status').set(as(ann)).expect(200)).body.result.waitingOnExecutor).toBeGreaterThanOrEqual(1);
    expect(await detail(job.id)).toMatchObject({ status: 'queued', attempts: 0, waitingReason: 'no executor', runs: [] });

    await addExecutor(ann, 'ann-late');
    expect(await dispatch()).toMatchObject({ fired: 1 });
    expect(await detail(job.id)).toMatchObject({ status: 'dispatched', waitingReason: null });
  });

  it("skips the executors of a deactivated owner: their jobs wait with 'owner deactivated' until reactivation", async () => {
    await addExecutor(bob, 'bob-exec');
    const job = await triageJob(bob, 'bob job');
    await http().post(`/api/v1/jobs/${job.id}/enqueue`).set(as(bob)).expect(200);
    await app.get(DataSource).query('UPDATE users SET deactivated_at = CURRENT_TIMESTAMP WHERE id = ?', [bob.id]);
    const result = await dispatch();
    expect(result.fired).toBe(0);
    expect(fired).toEqual([]);
    expect(await detail(job.id)).toMatchObject({ status: 'queued', waitingReason: 'owner deactivated' });

    await app.get(DataSource).query('UPDATE users SET deactivated_at = NULL WHERE id = ?', [bob.id]);
    expect((await dispatch()).fired).toBe(1);
    expect(fired).toHaveLength(1);
  });
});
