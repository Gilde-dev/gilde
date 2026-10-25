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

import { AppModule } from './../src/app.module.js';
import { createMastra } from './../src/copilot/copilot.mastra.js';
import { COPILOT_USER_KEY } from './../src/copilot/copilot.context.js';
import { COPILOT_CONFIG, COPILOT_MASTRA } from './../src/copilot/copilot.tokens.js';
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

async function createApp(override?: { config?: unknown; mastra?: Mastra }): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
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
    await request(app.getHttpServer()).get('/api/v1/copilot/status').set('Authorization', `Bearer ${token}`).expect(200).expect({ enabled: false, model: null });
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
    await request(app.getHttpServer()).get('/api/v1/copilot/status').set('Authorization', `Bearer ${tokenFor(app, user)}`).expect({ enabled: true, model: 'openai/test-model' });
  });

  it('is 401 on a Mastra route without a token', () => request(app.getHttpServer()).get('/api/v1/mastra/whoami').expect(401));

  it('runs Mastra routes as req.user, with the user id as memory resource', async () => {
    const user = await createTestUser(app);
    const res = await request(app.getHttpServer()).get('/api/v1/mastra/whoami').set('Authorization', `Bearer ${tokenFor(app, user)}`).expect(200);
    expect(res.body).toEqual({ user: { id: user.id, name: user.name, email: user.email }, resourceId: user.id });
  });

  it('runs Mastra routes as the owner of an API key', async () => {
    const owner = await createTestUser(app, { name: 'Bot' });
    const created = await request(app.getHttpServer()).post('/api/v1/api-keys').set({ Authorization: `Bearer ${tokenFor(app, owner)}` }).send({ name: 'channels' }).expect(201);
    const res = await request(app.getHttpServer()).get('/api/v1/mastra/whoami').set({ Authorization: `Bearer ${created.body.key}` }).expect(200);
    expect(res.body).toEqual({ user: { id: owner.id, name: 'Bot', email: owner.email }, resourceId: owner.id });
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
