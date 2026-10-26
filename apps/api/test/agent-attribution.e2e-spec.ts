import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { AgentUsage } from './../src/otel/agent-usage.entity.js';
import { authedAgent } from './helpers/auth.js';

const TOKEN = 'otel-ingest-secret-0123456789-abcdefghij';

describe('POST /api/v1/usage/agents/attribute (e2e)', () => {
  let app: INestApplication;
  const previous = process.env.OTEL_INGEST_TOKEN;

  beforeEach(async () => {
    process.env.OTEL_INGEST_TOKEN = TOKEN;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    if (previous === undefined) delete process.env.OTEL_INGEST_TOKEN;
    else process.env.OTEL_INGEST_TOKEN = previous;
  });

  it('requires ordinary authentication and rejects the ingest token', async () => {
    await request(app.getHttpServer()).post('/api/v1/usage/agents/attribute').expect(401);
    await request(app.getHttpServer()).post('/api/v1/usage/agents/attribute').set('Authorization', `Bearer ${TOKEN}`).expect(401);
  });

  it('delegates to the same pass as the schedule and returns counts', async () => {
    const http = await authedAgent(app);
    const sessionId = `e2e-${randomUUID()}`;
    await app.get(DataSource).getRepository(AgentUsage).insert({
      id: randomUUID(), runId: null, jobId: null, attribution: null, sessionId, model: 'm', eventAt: new Date(Date.now() - 3_600_000), eventKey: randomUUID(),
    });
    const res = await http.post('/api/v1/usage/agents/attribute').expect(201);
    // The SQLite file is shared with other tests, so only the shape is asserted, plus that this pass ran.
    expect(res.body).toEqual({
      skipped: false, sessionsExamined: expect.any(Number), sessionsBySession: expect.any(Number), sessionsByTimeWindow: expect.any(Number),
      sessionsAmbiguous: expect.any(Number), sessionsUnmatched: expect.any(Number), rowsAttributed: expect.any(Number), rowsUpgraded: expect.any(Number),
    });
    const stored = await app.get(DataSource).getRepository(AgentUsage).findOneByOrFail({ sessionId });
    expect(stored.runId === null || stored.attribution !== null).toBe(true);
  });
});
