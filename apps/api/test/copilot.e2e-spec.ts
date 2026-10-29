import type { INestApplication } from '@nestjs/common';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRunRecorder } from './../src/agent-run/agent-run.recorder.js';
import { AppModule } from './../src/app.module.js';
import { createMastra } from './../src/copilot/copilot.mastra.js';
import { COPILOT_USER_KEY } from './../src/copilot/copilot.context.js';
import { COPILOT_CONFIG, COPILOT_MASTRA, SCOUT_SETUP } from './../src/copilot/copilot.tokens.js';
import { scoutConfig } from './../src/copilot/verkenner.config.js';
import { ScoutThreads } from './../src/copilot/verkenner.threads.js';
import { testMemoryInfrastructure } from './../src/memory/memory.testing.js';
import { createTestUser, tokenFor } from './helpers/auth.js';

/** A Mastra instance whose only route reports what the interceptor put in the request context. */
function whoamiMastra() {
  return new Mastra({
    server: {
      apiRoutes: [
        registerApiRoute('/api/v1/mastra/whoami', {
          method: 'ALL',
          handler: (c) => {
            const rc = c.get('requestContext');
            return c.json({ user: rc.get(COPILOT_USER_KEY), resourceId: rc.get(MASTRA_RESOURCE_ID_KEY) });
          },
        }),
      ],
    },
  });
}

async function createApp(override?: { config?: unknown; mastra?: Mastra; scout?: unknown }): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (override?.scout) builder = builder.overrideProvider(SCOUT_SETUP).useValue(override.scout);
  if (override?.config) builder = builder.overrideProvider(COPILOT_CONFIG).useValue(override.config);
  if (override?.mastra) builder = builder.overrideProvider(COPILOT_MASTRA).useValue(override.mastra);
  const app = (await builder.compile()).createNestApplication();
  app.setGlobalPrefix('/api');
  await app.init();
  return app;
}

describe('Co-pilot (e2e), not configured', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.COPILOT_MODEL;
    app = await createApp();
    token = tokenFor(app, await createTestUser(app));
  });
  afterAll(() => app.close());

  it('the API starts and reports the co-pilot as disabled', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/copilot/status').set('Authorization', `Bearer ${token}`).expect(200).expect({ enabled: false, model: null, scout: { enabled: false, model: null, disabledReason: null }, refine: { enabled: false, model: null } });
  });

  it('requires a token on the status route', () => request(app.getHttpServer()).get('/api/v1/copilot/status').expect(401));

  it.each([
    ['GET', '/api/v1/mastra/health'],
    ['GET', '/api/v1/mastra/info'],
    ['GET', '/api/v1/mastra/agents'],
    ['POST', '/api/v1/mastra/copilotkit'],
    ['GET', '/api/v1/mastra/anything/else'],
  ])('%s %s is 401 without a token', async (method, path) => {
    await request(app.getHttpServer())[method.toLowerCase() as 'get' | 'post'](path).expect(401);
  });

  it('answers 503 with a clear message on Mastra routes', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/mastra/copilotkit').set('Authorization', `Bearer ${token}`).send({}).expect(503);
    expect(res.body.message).toContain('not configured');
  });

  it('does not shadow other routes', async () => {
    await request(app.getHttpServer()).get('/api/v1/projects').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
  });
});

describe('Co-pilot (e2e), configured', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ config: { enabled: true, model: 'openai/test-model' }, mastra: whoamiMastra() });
  });
  afterAll(() => app.close());

  it('reports the model', async () => {
    const user = await createTestUser(app);
    await request(app.getHttpServer()).get('/api/v1/copilot/status').set('Authorization', `Bearer ${tokenFor(app, user)}`).expect({ enabled: true, model: 'openai/test-model', scout: { enabled: false, model: null, disabledReason: null }, refine: { enabled: false, model: null } });
  });

  it('is 401 on a Mastra route without a token', () => request(app.getHttpServer()).get('/api/v1/mastra/whoami').expect(401));

  it('runs Mastra routes as req.user, with the user id as memory resource', async () => {
    const user = await createTestUser(app);
    const res = await request(app.getHttpServer()).get('/api/v1/mastra/whoami').set('Authorization', `Bearer ${tokenFor(app, user)}`).expect(200);
    expect(res.body).toEqual({ user: { id: user.id, name: user.name, email: user.email, credential: 'jwt' }, resourceId: user.id });
  });

  it('runs Mastra routes as the owner of an API key', async () => {
    const owner = await createTestUser(app, { name: 'Bot' });
    const created = await request(app.getHttpServer()).post('/api/v1/api-keys').set({ Authorization: `Bearer ${tokenFor(app, owner)}` }).send({ name: 'channels' }).expect(201);
    const res = await request(app.getHttpServer()).get('/api/v1/mastra/whoami').set({ Authorization: `Bearer ${created.body.key}` }).expect(200);
    expect(res.body).toEqual({ user: { id: owner.id, name: 'Bot', email: owner.email, credential: 'api_key' }, resourceId: owner.id });
  });

  it('ignores a user or resource id sent by the client', async () => {
    const user = await createTestUser(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/mastra/whoami')
      .set('Authorization', `Bearer ${tokenFor(app, user)}`)
      .send({ requestContext: { [COPILOT_USER_KEY]: { id: 'someone-else' }, [MASTRA_RESOURCE_ID_KEY]: 'someone-else' } })
      .expect(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.resourceId).toBe(user.id);
  });
});

describe('Co-pilot (e2e), CopilotKit route', () => {
  let app: INestApplication;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const config = { enabled: true as const, model: 'openai/test-model' };
    const mastra = createMastra(config, {} as never, new LibSQLStore({ id: 'e2e', url: 'file::memory:' }));
    app = await createApp({ config, mastra });
    headers = { Authorization: `Bearer ${tokenFor(app, await createTestUser(app))}` };
  });
  afterAll(() => app.close());

  it('serves the registerCopilotKit route inside the Mastra prefix and exposes the gilde agent', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/mastra/copilotkit').set(headers).send({ method: 'info' }).expect(200);
    expect(Object.keys(res.body.agents)).toEqual(['gilde']);
  });

  it('is 401 without a token', () => request(app.getHttpServer()).post('/api/v1/mastra/copilotkit').send({ method: 'info' }).expect(401));
});

describe('Co-pilot (e2e), memory isolation on Mastra routes', () => {
  let app: INestApplication;
  let dir: string;
  let mastra: Mastra;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let bob: Awaited<ReturnType<typeof createTestUser>>;
  let aliceAuth: { Authorization: string };
  let bobAuth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-memory-'));
    const config = { enabled: true as const, model: 'openai/test-model' };
    mastra = createMastra(config, {} as never, new LibSQLStore({ id: 'e2e-mem', url: `file:${join(dir, 'm.db')}` }));
    app = await createApp({ config, mastra });
    alice = await createTestUser(app);
    bob = await createTestUser(app);
    aliceAuth = { Authorization: `Bearer ${tokenFor(app, alice)}` };
    bobAuth = { Authorization: `Bearer ${tokenFor(app, bob)}` };
    const memory = await mastra.getStorage()!.getStore('memory');
    await memory!.saveThread({ thread: { id: 'alice-thread', resourceId: alice.id, title: 'private', createdAt: new Date(), updatedAt: new Date(), metadata: {} } });
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets the owner read their thread', async () => {
    await http().get('/api/v1/mastra/memory/threads/alice-thread?agentId=gilde').set(aliceAuth).expect(200);
  });

  it('hides a foreign thread for reads, writes and deletes', async () => {
    await http().get('/api/v1/mastra/memory/threads/alice-thread?agentId=gilde').set(bobAuth).expect(404);
    await http().get('/api/v1/mastra/memory/threads/alice-thread/messages?agentId=gilde').set(bobAuth).expect(404);
    await http().get('/api/v1/mastra/memory/threads/alice-thread/working-memory?agentId=gilde').set(bobAuth).expect(404);
    await http().delete('/api/v1/mastra/memory/threads/alice-thread?agentId=gilde').set(bobAuth).expect(404);
    await http().post('/api/v1/mastra/memory/save-messages?agentId=gilde').set(bobAuth).send({ messages: [{ id: 'm', threadId: 'alice-thread', role: 'user', content: 'x' }] }).expect(404);
    await http().post('/api/v1/mastra/memory/threads/alice-thread/clone?agentId=gilde').set(bobAuth).send({}).expect(404);
    const stillThere = await http().get('/api/v1/mastra/memory/threads/alice-thread?agentId=gilde').set(aliceAuth).expect(200);
    expect(stillThere.body.title).toBe('private');
  });

  it('rejects a client-supplied foreign resourceId in query and body', async () => {
    await http().get(`/api/v1/mastra/memory/threads?agentId=gilde&resourceId=${alice.id}`).set(bobAuth).expect(403);
    await http().get(`/api/v1/mastra/memory/search?agentId=gilde&searchQuery=private&resourceId=${alice.id}`).set(bobAuth).expect(403);
    await http().post('/api/v1/mastra/memory/threads?agentId=gilde').set(bobAuth).send({ resourceId: alice.id, title: 'x' }).expect(403);
    await http().post('/api/v1/mastra/copilotkit').set(bobAuth).send({ method: 'info', memory: { resource: alice.id } }).expect(403);
  });

  it('pins thread listing to the caller when the client names no resource', async () => {
    const bobs = await http().get('/api/v1/mastra/memory/threads?agentId=gilde').set(bobAuth).expect(200);
    expect(JSON.stringify(bobs.body)).not.toContain('alice-thread');
    const alices = await http().get('/api/v1/mastra/memory/threads?agentId=gilde').set(aliceAuth).expect(200);
    expect(JSON.stringify(alices.body)).toContain('alice-thread');
  });

  it('rejects a foreign thread id on the CopilotKit route', async () => {
    await http().post('/api/v1/mastra/copilotkit').set(bobAuth).send({ threadId: 'alice-thread', messages: [] }).expect(404);
  });

  it('applies the same rules to API keys', async () => {
    const created = await http().post('/api/v1/api-keys').set(bobAuth).send({ name: 'bot' }).expect(201);
    const keyAuth = { Authorization: `Bearer ${created.body.key}` };
    await http().get('/api/v1/mastra/memory/threads/alice-thread?agentId=gilde').set(keyAuth).expect(404);
    await http().get(`/api/v1/mastra/memory/threads?agentId=gilde&resourceId=${alice.id}`).set(keyAuth).expect(403);
  });
});

describe('Verkenner (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  let mastra: Mastra;
  let bot: Awaited<ReturnType<typeof createTestUser>>;
  let botEmail: string;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let aliceAuth: { Authorization: string };
  let botAuth: { Authorization: string };
  const PROJECT = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-verkenner-'));
    const config = { enabled: true as const, model: 'openai/test-model' };
    botEmail = `verkenner-${Date.now()}@example.com`;
    const scoutCfg = scoutConfig({ SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: botEmail, SCOUT_MODEL: 'openai/scout-model', OPENAI_API_KEY: 'k' });
    if (!scoutCfg.enabled) throw new Error('test setup');
    // The bot user is created in the app below; its id is filled in afterwards.
    const scout = { config: scoutCfg, user: { id: '', name: 'Verkenner', email: botEmail } };
    mastra = createMastra(config, {} as never, undefined, undefined, testMemoryInfrastructure({ url: `file:${join(dir, 'v.db')}` }), undefined, scout);
    app = await createApp({ config, mastra, scout });
    bot = await createTestUser(app, { name: 'Verkenner', email: botEmail });
    scout.user.id = bot.id;
    alice = await createTestUser(app);
    aliceAuth = { Authorization: `Bearer ${tokenFor(app, alice)}` };
    botAuth = { Authorization: `Bearer ${tokenFor(app, bot)}` };
    const threads = new ScoutThreads(mastra, scout.user, { getById: async () => ({}) });
    await threads.ensureThread(PROJECT);
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the scout on the status route next to the unchanged co-pilot fields', async () => {
    await http().get('/api/v1/copilot/status').set(aliceAuth).expect(200).expect({ enabled: true, model: 'openai/test-model', scout: { enabled: true, model: 'openai/scout-model', disabledReason: null }, refine: { enabled: false, model: null } });
  });

  it('does not list the scout on the CopilotKit route', async () => {
    const res = await http().post('/api/v1/mastra/copilotkit').set(aliceAuth).send({ method: 'info' }).expect(200);
    expect(Object.keys(res.body.agents)).toEqual(['gilde']);
  });

  it('cannot be run or inspected through Mastra routes by anyone, the bot user included', async () => {
    for (const auth of [aliceAuth, botAuth]) {
      await http().get('/api/v1/mastra/agents/verkenner').set(auth).expect(403);
      await http().post('/api/v1/mastra/agents/verkenner/generate').set(auth).send({ messages: [{ role: 'user', content: 'list jobs' }], requestContext: { verkennerBinding: { userId: bot.id, projectId: PROJECT } } }).expect(403);
      await http().post('/api/v1/mastra/agents/verkenner/stream').set(auth).send({ messages: [] }).expect(403);
      await http().post('/api/v1/mastra/copilotkit').set(auth).send({ method: 'agent/run', params: { agentId: 'verkenner' }, body: {} }).expect(403);
      await http().get('/api/v1/mastra/memory/threads?agentId=verkenner').set(auth).expect(403);
      await http().post('/api/v1/mastra/workflows/__mastra_notification_dispatcher/start-async').set(auth).send({}).expect(403);
    }
  });

  it('logs the refused attempts in the run log of the agent they named', async () => {
    await app.get(AgentRunRecorder).flush();
    const res = await http().get('/api/v1/agents/verkenner/runs?outcome=refused').set(aliceAuth).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.items[0]).toMatchObject({ agentId: 'verkenner', outcome: 'refused', reason: 'The agent cannot be used through the API' });
    expect([alice.id, bot.id]).toContain(res.body.items[0].actorUserId);
  });

  it("keeps the bot's memory away from users: foreign thread 404, foreign resource 403", async () => {
    await http().get(`/api/v1/mastra/memory/threads/verkenner:${PROJECT}?agentId=gilde`).set(aliceAuth).expect(404);
    await http().get(`/api/v1/mastra/memory/threads/verkenner:${PROJECT}/messages?agentId=gilde`).set(aliceAuth).expect(404);
    await http().get(`/api/v1/mastra/memory/threads?agentId=gilde&resourceId=${bot.id}`).set(aliceAuth).expect(403);
    const own = await http().get('/api/v1/mastra/memory/threads?agentId=gilde').set(aliceAuth).expect(200);
    expect(JSON.stringify(own.body)).not.toContain('verkenner:');
  });
});

describe('Verkenner (e2e), configured but unusable', () => {
  const keys = ['SCOUT_ENABLED', 'SCOUT_USER_EMAIL', 'SCOUT_MODEL', 'OPENAI_API_KEY', 'COPILOT_MODEL'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterAll(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is on with only the scout configured (no co-pilot model) when the user exists', async () => {
    process.env.SCOUT_ENABLED = 'true';
    process.env.SCOUT_USER_EMAIL = 'bot@example.com';
    process.env.SCOUT_MODEL = 'openai/scout-model';
    process.env.OPENAI_API_KEY = 'k';
    delete process.env.COPILOT_MODEL;
    const config = scoutConfig(process.env);
    if (!config.enabled) throw new Error('test setup');
    const setup = { config, user: { id: 'bot-id', name: 'Bot', email: 'bot@example.com' } };
    const mastra = createMastra({ enabled: false, model: null, reason: 'COPILOT_MODEL is not set' }, {} as never, new LibSQLStore({ id: 'e2e-scout', url: 'file::memory:' }), undefined, undefined, undefined, setup);
    const app = await createApp({ config: { enabled: false, model: null, reason: 'COPILOT_MODEL is not set' }, mastra, scout: setup });
    try {
      const token = tokenFor(app, await createTestUser(app));
      await request(app.getHttpServer()).get('/api/v1/copilot/status').set('Authorization', `Bearer ${token}`).expect(200).expect({ enabled: false, model: null, scout: { enabled: true, model: 'openai/scout-model', disabledReason: null }, refine: { enabled: false, model: null } });
      expect(Object.keys(mastra.listAgents())).toEqual(['verkenner']);
    } finally {
      await app.close();
    }
  });
});

describe('Co-pilot (e2e), conversations list', () => {
  let app: INestApplication;
  let dir: string;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let bob: Awaited<ReturnType<typeof createTestUser>>;
  let aliceAuth: { Authorization: string };
  let bobAuth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-threads-'));
    const config = { enabled: true as const, model: 'openai/test-model' };
    const mastra = createMastra(config, {} as never, new LibSQLStore({ id: 'e2e-threads', url: `file:${join(dir, 'm.db')}` }));
    app = await createApp({ config, mastra });
    alice = await createTestUser(app);
    bob = await createTestUser(app);
    aliceAuth = { Authorization: `Bearer ${tokenFor(app, alice)}` };
    bobAuth = { Authorization: `Bearer ${tokenFor(app, bob)}` };
    const store = (await mastra.getStorage()!.getStore('memory'))!;
    const save = (id: string, resourceId: string, title: string, at: string) =>
      store.saveThread({ thread: { id, resourceId, title, createdAt: new Date(at), updatedAt: new Date(at), metadata: {} } });
    await save('a-old', alice.id, 'First', '2026-01-01T00:00:00Z');
    await save('a-new', alice.id, '', '2026-02-01T00:00:00Z');
    await save('b-1', bob.id, 'Bobs', '2026-03-01T00:00:00Z');
    await save('verkenner:p', alice.id, 'Scout', '2026-04-01T00:00:00Z');
    await store.saveMessages({
      messages: [{ id: 'm1', threadId: 'a-new', resourceId: alice.id, role: 'user', createdAt: new Date('2026-02-01T00:00:01Z'), content: { format: 2, parts: [{ type: 'text', text: 'How many jobs are queued?' }] } }],
    } as never);
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires a token', async () => {
    await http().get('/api/v1/copilot/threads').expect(401);
    await http().get('/api/v1/copilot/threads/a-old/messages').expect(401);
  });

  it('lists only the caller\'s threads, newest first, with titles', async () => {
    const res = await http().get('/api/v1/copilot/threads').set(aliceAuth).expect(200);
    expect(res.body.map((t: { id: string; title: string }) => [t.id, t.title])).toEqual([['a-new', 'How many jobs are queued?'], ['a-old', 'First']]);
    expect(Object.keys(res.body[0]).sort()).toEqual(['createdAt', 'id', 'title', 'updatedAt']);
    const bobs = await http().get('/api/v1/copilot/threads').set(bobAuth).expect(200);
    expect(bobs.body.map((t: { id: string }) => t.id)).toEqual(['b-1']);
  });

  it('reads the messages of an own thread', async () => {
    const res = await http().get('/api/v1/copilot/threads/a-new/messages').set(aliceAuth).expect(200);
    expect(res.body.messages).toEqual([{ id: 'm1', role: 'user', content: 'How many jobs are queued?' }]);
  });

  it('404 for another user\'s thread, the scout\'s thread and an unknown id', async () => {
    await http().get('/api/v1/copilot/threads/a-new/messages').set(bobAuth).expect(404);
    await http().get('/api/v1/copilot/threads/verkenner:p/messages').set(aliceAuth).expect(404);
    await http().get('/api/v1/copilot/threads/nope/messages').set(aliceAuth).expect(404);
  });

  it('applies the same rules to API keys', async () => {
    const created = await http().post('/api/v1/api-keys').set(bobAuth).send({ name: 'bot' }).expect(201);
    const keyAuth = { Authorization: `Bearer ${created.body.key}` };
    const list = await http().get('/api/v1/copilot/threads').set(keyAuth).expect(200);
    expect(list.body.map((t: { id: string }) => t.id)).toEqual(['b-1']);
    await http().get('/api/v1/copilot/threads/a-new/messages').set(keyAuth).expect(404);
  });
});
