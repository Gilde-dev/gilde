import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';
import { createApiKey, createTestUser, tokenFor } from './helpers/auth.js';

describe('MCP switch off (e2e)', () => {
  let app: INestApplication;
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  beforeAll(async () => {
    expect(process.env.MCP_ENABLED).toBeUndefined();
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 404 without credentials, before authentication', async () => {
    await request(app.getHttpServer()).post('/api/v1/mcp').set('Accept', 'application/json, text/event-stream').send(body).expect(404);
    await request(app.getHttpServer()).get('/api/v1/mcp').expect(404);
  });

  it('answers 404 with valid credentials too, for a JWT and for an API key', async () => {
    const user = await createTestUser(app);
    const key = await createApiKey(app, user);
    for (const auth of [`Bearer ${tokenFor(app, user)}`, `Bearer ${key}`]) {
      await request(app.getHttpServer()).post('/api/v1/mcp').set('Authorization', auth).set('Accept', 'application/json, text/event-stream').send(body).expect(404);
    }
  });

  it('leaves the other routes as they were: still protected, still reachable', async () => {
    const user = await createTestUser(app);
    await request(app.getHttpServer()).get('/api/v1/projects').expect(401);
    await request(app.getHttpServer()).get('/api/v1/projects').set({ Authorization: `Bearer ${tokenFor(app, user)}` }).expect(200);
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });
});
