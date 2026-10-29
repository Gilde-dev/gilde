import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Repository } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { COPILOT_CONFIG, PLAN_SETUP } from './../src/copilot/copilot.tokens.js';
import { scriptedModel, type ScriptedStep } from './../src/copilot/verfijner.testing.js';
import { planConfig } from './../src/copilot/werkmeester.config.js';
import { WerkmeesterService } from './../src/copilot/werkmeester.service.js';
import { Feature } from './../src/feature/feature.entity.js';
import { Job } from './../src/job/job.entity.js';
import { JobDependency } from './../src/job/job-dependency.entity.js';
import { MEMORY_INFRASTRUCTURE } from './../src/memory/memory.tokens.js';
import { testMemoryInfrastructure } from './../src/memory/memory.testing.js';
import { SpecRecording } from './../src/spec/spec-recording.entity.js';
import { UserService } from './../src/user/user.service.js';
import { authedAgent, createTestUser, tokenFor } from './helpers/auth.js';

const FETCH = 'First run `git fetch origin && git rebase origin/main`.';
const specBody = [
  '## Goal\n\nShip it.', '## Context\n\nWhy.', '## Behaviour\n\nHow.',
  '## Acceptance criteria\n\n- AC-1: First\n- AC-2: Second', '## Out of scope\n\nNothing.', '## Open questions\n\nNone',
].join('\n\n') + '\n';

describe('Werkmeester (e2e), service path with a fake model', () => {
  let app: INestApplication;
  let dir: string;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let bot: Awaited<ReturnType<typeof createTestUser>>;
  let service: WerkmeesterService;
  let projectId: string;
  let repoId: string;
  let specId: string;
  let approvalId: string;
  const repo = <T extends object>(e: new () => T) => app.get<Repository<T>>(getRepositoryToken(e));

  const job = (key: string, task: string, dependsOn: string[] = []) => ({ key, repoId, title: `Job ${key}`, task: `${FETCH} ${task}`, acceptanceCriteria: [`${key} works`], dependsOn });
  // The scripted model plays these in order across runs; filled once the repo id is known.
  const steps: ScriptedStep[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-werkmeester-'));
    const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
    await infra.storage.init();
    const stub = scriptedModel(steps);
    const config = planConfig({ PLAN_ENABLED: 'true', PLAN_USER_EMAIL: 'bot@example.com', PLAN_MODEL: 'openai/plan-model', OPENAI_API_KEY: 'k' });
    if (!config.enabled) throw new Error('test setup');
    const setup = { config, user: { id: '', name: 'Werkmeester', email: 'bot@example.com' }, model: stub.model };

    app = (await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(COPILOT_CONFIG).useValue({ enabled: true, model: 'openai/test-model' })
      .overrideProvider(MEMORY_INFRASTRUCTURE).useValue(infra)
      .overrideProvider(PLAN_SETUP).useValue(setup)
      .compile()).createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();

    bot = await createTestUser(app, { name: 'Werkmeester', email: `bot-${randomUUID()}@example.com` });
    await app.get(UserService).markBot(bot.email);
    setup.user.id = bot.id;
    http = await authedAgent(app);
    service = app.get(WerkmeesterService);

    const slug = `wm-${randomUUID().slice(0, 8)}`;
    projectId = (await http.post('/api/v1/projects').send({ slug, name: 'Plan' }).expect(201)).body.id;
    repoId = (await http.post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    steps.push(
      // run 1: a task without the fetch line, then the fix
      { tool: 'proposePlan', input: { title: 'Planned', description: 'Do it.', jobs: [{ ...job('api', 'AC-1 AC-2'), task: 'AC-1 AC-2' }] } },
      { tool: 'proposePlan', input: { title: 'Planned', description: 'Do it.', jobs: [job('api', 'Build. Covers AC-1.'), job('web', 'Show. Covers AC-2.', ['api'])] } },
      { text: 'Planned.' },
      // run 2 is skipped before the agent runs; run 3 (second spec) is a hostile one
      { tool: 'proposePlan', input: { title: 'Hostile', description: 'x', projectId: randomUUID(), specId: randomUUID(), specApproval: { version: 5, approvalId: randomUUID() }, jobs: [job('only', 'Covers AC-1 and AC-2.')] } },
      { text: 'Done.' },
  );
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const approvedSpec = async () => {
    const created = (await http.post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: `s-${randomUUID().slice(0, 8)}`, title: 'A spec', body: specBody, expectedVersion: 0 }).expect(201)).body;
    const detail = (await http.post(`/api/v1/specs/${created.id}/approve`).send({ expectedVersion: 1 }).expect(200)).body;
    specId = created.id;
    approvalId = detail.versions[0].approval.id;
    return { detail, target: { projectId, specId: created.id as string, version: 1, approvalId: approvalId } };
  };

  it('is on with the bot user', () => {
    expect(service.enabled).toBe(true);
  });

  let featureId: string;
  let recordingJobId: string;

  it('plans an approved version: fixable error, then a draft feature pinned to the version with triage jobs waiting for the recording job', async () => {
    const { detail, target } = await approvedSpec();
    recordingJobId = detail.versions[0].recording.jobId;
    const result = await service.plan(service.bind(target, 1));
    expect(result).toMatchObject({ outcome: 'planned' });
    featureId = (result as { featureId: string }).featureId;

    const feature = await repo(Feature).findOneByOrFail({ id: featureId });
    expect(feature).toMatchObject({ status: 'draft', specId, specVersion: 1 });
    expect(feature.specPin).toMatchObject({ approvalId, version: 1 });
    expect((await repo(SpecRecording).findOneByOrFail({ specId, version: 1 })).pinnedByFeatureId).toBe(featureId);

    const jobs = await repo(Job).find({ where: { featureId } });
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.status).toBe('triage');
      expect(j.createdById).toBe(bot.id);
      expect(j.task).toContain('Approved spec (pinned)');
      expect(j.task.startsWith(FETCH)).toBe(true);
      const deps = await repo(JobDependency).find({ where: { jobId: j.id } });
      expect(deps.map((d) => d.dependsOnJobId)).toContain(recordingJobId);
    }
    const web = jobs.find((j) => j.title === 'Job web')!;
    expect((await repo(JobDependency).find({ where: { jobId: web.id } })).map((d) => d.dependsOnJobId)).toContain(jobs.find((j) => j.title === 'Job api')!.id);
  });

  it('skips a version that already has a pinned feature, without creating anything', async () => {
    const before = await repo(Feature).count();
    const result = await service.plan(service.bind({ projectId, specId, version: 1, approvalId }, 1));
    expect(result).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('already has a feature pinned') });
    expect(await repo(Feature).count()).toBe(before);
  });

  it('keeps the spec, version and approval of the binding even when the model passes others', async () => {
    const { target } = await approvedSpec();
    const result = await service.plan(service.bind(target, 1));
    expect(result).toMatchObject({ outcome: 'planned' });
    const feature = await repo(Feature).findOneByOrFail({ id: (result as { featureId: string }).featureId });
    expect(feature).toMatchObject({ projectId, specId: target.specId, specVersion: 1 });
  });

  it('refuses the werkmeester on every Mastra route, for humans and the bot alike', async () => {
    const human = { Authorization: `Bearer ${tokenFor(app, await createTestUser(app))}` };
    const botAuth = { Authorization: `Bearer ${tokenFor(app, bot)}` };
    const server = () => request(app.getHttpServer());
    for (const auth of [human, botAuth]) {
      await server().get('/api/v1/mastra/agents/werkmeester').set(auth).expect(403);
      await server().post('/api/v1/mastra/agents/werkmeester/generate').set(auth).send({ messages: [{ role: 'user', content: 'x' }], requestContext: { werkmeesterBinding: { userId: bot.id, projectId } } }).expect(403);
      await server().post('/api/v1/mastra/agents/werkmeester/stream').set(auth).send({ messages: [] }).expect(403);
      await server().post('/api/v1/mastra/copilotkit').set(auth).send({ method: 'agent/run', params: { agentId: 'werkmeester' }, body: {} }).expect(403);
      await server().get('/api/v1/mastra/memory/threads?agentId=werkmeester').set(auth).expect(403);
    }
    const info = await server().post('/api/v1/mastra/copilotkit').set(human).send({ method: 'info' }).expect(200);
    expect(Object.keys(info.body.agents)).not.toContain('werkmeester');
  });
});

describe('Werkmeester (e2e), off', () => {
  it('leaves the API running, with a service that is not enabled, when PLAN_ENABLED is not set', async () => {
    const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    try {
      expect(app.get(PLAN_SETUP, { strict: false })).toBeNull();
      expect(app.get(WerkmeesterService, { strict: false }).enabled).toBe(false);
      await request(app.getHttpServer()).get('/api/health').expect(200);
    } finally {
      await app.close();
    }
  });
});
