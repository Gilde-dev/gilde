import type { INestApplication } from '@nestjs/common';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { Test } from '@nestjs/testing';
import request from 'supertest';

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
