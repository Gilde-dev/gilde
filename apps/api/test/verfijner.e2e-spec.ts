import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { COPILOT_CONFIG, REFINE_SETUP, REFINE_WORKER } from './../src/copilot/copilot.tokens.js';
import { refineConfig } from './../src/copilot/verfijner.config.js';
import { scriptedModel, validSpecBody, type ScriptedStep } from './../src/copilot/verfijner.testing.js';
import type { VerfijnerWorker } from './../src/copilot/verfijner.worker.js';
import { IntakeItem } from './../src/intake/intake-item.entity.js';
import { MEMORY_INFRASTRUCTURE } from './../src/memory/memory.tokens.js';
import { testMemoryInfrastructure } from './../src/memory/memory.testing.js';
import { UserService } from './../src/user/user.service.js';
import { authedAgent, createTestUser, tokenFor } from './helpers/auth.js';

const SECRET = 'verfijner-webhook-secret';

describe('Verfijner (e2e), worker path with a fake model', () => {
  let app: INestApplication;
  let dir: string;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let bot: Awaited<ReturnType<typeof createTestUser>>;
  let worker: VerfijnerWorker;
  let prompts: ReturnType<typeof scriptedModel>['prompts'];

  const slug = `vf-${randomUUID().slice(0, 8)}`;
  const fullName = `o/${slug}`;
  const issueUrl = `https://github.com/${fullName}/issues/5`;
  let projectId: string;

  // The scripted model plays these in order across runs.
  const steps: ScriptedStep[] = [
    // run 1: a body the parser rejects, then the fix
    { tool: 'saveRefinedSpec', input: { title: 'Export to CSV', body: '## Goal\n\nonly a goal' } },
    { tool: 'saveRefinedSpec', input: { title: 'Export to CSV', body: validSpecBody(issueUrl) } },
    { text: 'Saved the draft.' },
    // run 2 (after the issue was edited): a new version that keeps AC-1
    { tool: 'saveRefinedSpec', input: { title: 'Export to CSV and JSON', body: validSpecBody(issueUrl, '- AC-2: The export can be limited to a date range.\n') } },
    { text: 'Saved a new version.' },
  ];

  beforeAll(async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-verfijner-'));
    const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
    await infra.storage.init();
    const stub = scriptedModel(steps);
    prompts = stub.prompts;
    const config = refineConfig({ REFINE_ENABLED: 'true', REFINE_USER_EMAIL: 'bot@example.com', REFINE_MODEL: 'openai/refine-model', OPENAI_API_KEY: 'k', REFINE_DAILY_LIMIT: '2' });
    if (!config.enabled) throw new Error('test setup');
    const setup = { config, user: { id: '', name: 'Verfijner', email: 'bot@example.com' }, model: stub.model };

    app = (await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(COPILOT_CONFIG).useValue({ enabled: true, model: 'openai/test-model' })
      .overrideProvider(MEMORY_INFRASTRUCTURE).useValue(infra)
      .overrideProvider(REFINE_SETUP).useValue(setup)
      .compile()).createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();
    // The worker serves every project: park items left in the shared test database so the script only meets this file's item.
    await app.get(DataSource).getRepository(IntakeItem).update({ status: 'new' }, { status: 'ignored' });

    bot = await createTestUser(app, { name: 'Verfijner', email: `bot-${randomUUID()}@example.com` });
    await app.get(UserService).markBot(bot.email);
    setup.user.id = bot.id;
    http = await authedAgent(app);
    worker = app.get<VerfijnerWorker>(REFINE_WORKER);

    const project = (await http.post('/api/v1/projects').send({ slug, name: 'Refine' }).expect(201)).body;
    projectId = project.id;
    await http.post(`/api/v1/projects/${projectId}/repos`).send({ fullName }).expect(201);
  });
  afterAll(async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const deliver = (action: string, issue: Record<string, unknown> = {}) => {
    const body = JSON.stringify({
      action, repository: { full_name: fullName },
      issue: { number: 5, node_id: 'I_kwDO5', html_url: issueUrl, title: 'Export to CSV', body: 'Users want a CSV export.', state: 'open', user: { login: 'octo' }, labels: [{ name: 'gilde:refine' }], ...issue },
    });
    return request(app.getHttpServer()).post('/api/webhooks/github').set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues').set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`).send(body);
  };
  const items = async () => (await http.get(`/api/v1/projects/${projectId}/intake`).expect(200)).body as Array<{ id: string; status: string; specId: string | null; refineAttempts: number }>;

  it('refines a new item into a parser-valid draft spec made by the bot, linked to the issue', async () => {
    await deliver('labeled').expect(200);
    expect((await items())[0]).toMatchObject({ status: 'new', specId: null });

    const ran = await worker.tick();
    expect(ran).toHaveLength(1);

    const [item] = await items();
    expect(item).toMatchObject({ status: 'drafted', refineAttempts: 1 });
    expect(item.specId).not.toBeNull();
    // The issue text reached the model as delimited data.
    expect(JSON.stringify(prompts[0])).toContain('BEGIN ISSUE BODY');

    const spec = (await http.get(`/api/v1/specs/${item.specId}`).expect(200)).body;
    expect(spec).toMatchObject({
      slug: 'issue-5-export-to-csv', status: 'draft', currentVersion: 1, approvedVersion: null, createdById: bot.id,
      source: { kind: 'github_issue', url: issueUrl, number: 5 },
    });
    expect(spec.versions[0].body).toContain(issueUrl);
    const list = (await http.get(`/api/v1/projects/${projectId}/specs`).expect(200)).body as Array<{ id: string; source: unknown }>;
    expect(list.find((s) => s.id === item.specId)?.source).toEqual({ kind: 'github_issue', url: issueUrl, number: 5 });
    // Nothing else was made: no job was queued for the project.
    expect((await http.get(`/api/v1/jobs?projectId=${projectId}`).expect(200)).body).toEqual([]);
  });

  it('does not run again for an unchanged drafted item', async () => {
    expect(await worker.tick()).toEqual([]);
  });

  it('adds a draft version after an edit and leaves an approved version approved', async () => {
    const [item] = await items();
    await http.post(`/api/v1/specs/${item.specId}/approve`).send({ expectedVersion: 1 }).expect(200);

    await deliver('edited', { title: 'Export to CSV and JSON', body: 'Users want CSV and JSON exports.' }).expect(200);
    expect((await items())[0]).toMatchObject({ status: 'new' });
    expect(await worker.tick()).toHaveLength(1);

    const spec = (await http.get(`/api/v1/specs/${item.specId}`).expect(200)).body;
    expect(spec).toMatchObject({ currentVersion: 2, approvedVersion: 1, status: 'draft', title: 'Export to CSV and JSON' });
    expect(spec.versions.find((v: { version: number }) => v.version === 1).approval).not.toBeNull();
    expect((await items())[0]).toMatchObject({ status: 'drafted' });
  });

  it('stops at the project\'s daily limit and leaves the item new', async () => {
    await deliver('edited', { title: 'Export to CSV and JSON', body: 'Once more, with feeling.' }).expect(200);
    expect(await worker.tick()).toEqual([]);
    expect((await items())[0]).toMatchObject({ status: 'new' });
  });

  it('refuses the verfijner on every Mastra route, for humans and the bot alike', async () => {
    const human = { Authorization: `Bearer ${tokenFor(app, await createTestUser(app))}` };
    const botAuth = { Authorization: `Bearer ${tokenFor(app, bot)}` };
    const server = () => request(app.getHttpServer());
    for (const auth of [human, botAuth]) {
      await server().get('/api/v1/mastra/agents/verfijner').set(auth).expect(403);
      await server().post('/api/v1/mastra/agents/verfijner/generate').set(auth).send({ messages: [{ role: 'user', content: 'x' }], requestContext: { verfijnerBinding: { userId: bot.id, projectId } } }).expect(403);
      await server().post('/api/v1/mastra/agents/verfijner/stream').set(auth).send({ messages: [] }).expect(403);
      await server().post('/api/v1/mastra/copilotkit').set(auth).send({ method: 'agent/run', params: { agentId: 'verfijner' }, body: {} }).expect(403);
      await server().get('/api/v1/mastra/memory/threads?agentId=verfijner').set(auth).expect(403);
    }
    const info = await server().post('/api/v1/mastra/copilotkit').set(human).send({ method: 'info' }).expect(200);
    expect(Object.keys(info.body.agents)).not.toContain('verfijner');
  });
});

describe('Verfijner (e2e), off', () => {
  it('leaves the API running and items new when REFINE_ENABLED is not set', async () => {
    const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    try {
      expect(app.get(REFINE_SETUP, { strict: false })).toBeNull();
      expect(app.get(REFINE_WORKER, { strict: false })).toBeNull();
      await request(app.getHttpServer()).get('/api/health').expect(200);
    } finally {
      await app.close();
    }
  });
});
