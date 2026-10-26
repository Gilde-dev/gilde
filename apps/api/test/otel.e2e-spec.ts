import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { vi } from 'vitest';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { AgentUsage } from './../src/otel/agent-usage.entity.js';
import { SENSITIVE, apiRequest, int, logsRequest, otherEvent, sampleLogsRequest, str } from './../src/otel/otel.fixture.js';
import { OtelService } from './../src/otel/otel.service.js';
import { RunService } from './../src/run/run.service.js';
import { authHeaders } from './helpers/auth.js';

const TOKEN = 'otel-ingest-secret-0123456789-abcdefghij';
const LOGS = '/api/v1/otel/v1/logs';
const METRICS = '/api/v1/otel/v1/metrics';

const ENV_KEYS = ['OTEL_INGEST_TOKEN', 'OTEL_INGEST_RATE_LIMIT', 'AUTH_ENABLED', 'JWT_SECRET'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function createApp(): Promise<INestApplication> {
  const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ bodyParser: false });
  app.setGlobalPrefix('/api');
  configureBodyParsing(app);
  await app.init();
  return app;
}

/** A logs request whose sessions are unique to this test (the SQLite file is shared between tests). */
function uniqueLogs(session: string, extra: unknown[] = []) {
  const withSession = (r: ReturnType<typeof apiRequest>) => ({ ...r });
  return logsRequest([
    withSession(apiRequest({ attributes: { 'session.id': str(session), 'event.sequence': int(1) } })),
    otherEvent(),
    withSession(apiRequest({
      timeUnixNano: '1700000002000000000',
      attributes: { 'session.id': str(session), 'event.sequence': int(2), model: str('claude-synthetic-2'), input_tokens: int(10), output_tokens: int(5), cache_read_tokens: int(0), cache_creation_tokens: int(0), cost_usd: null, duration_ms: null },
    })),
    ...extra,
  ]);
}

describe('OTLP ingest (e2e)', () => {
  let app: INestApplication;
  let rows: ReturnType<DataSource['getRepository']>;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    process.env.OTEL_INGEST_TOKEN = TOKEN;
    process.env.OTEL_INGEST_RATE_LIMIT = '100000';
    app = await createApp();
    await app.listen(0); // concurrent supertest requests need an already listening server
    rows = app.get(DataSource).getRepository(AgentUsage);
  });
  afterAll(() => app.close());

  const post = (path: string, headers: Record<string, string> = auth) =>
    request(app.getHttpServer()).post(path).set(headers).set('Content-Type', 'application/json');
  const stored = (session: string) => app.get(OtelService).listBySession(session);

  describe('authentication', () => {
    it('answers 401 without or with a wrong token', async () => {
      await post(LOGS, {}).send({}).expect(401);
      await post(LOGS, { Authorization: 'Bearer wrong' }).send({}).expect(401);
      await post(METRICS, {}).send({}).expect(401);
      await post(METRICS, { Authorization: `Bearer ${TOKEN}x` }).send({}).expect(401);
    });

    it('rejects gk_ API keys and normal JWTs', async () => {
      await post(LOGS, { Authorization: 'Bearer gk_abcd1234_0123456789abcdef0123456789abcdef' }).send({}).expect(401);
      await post(METRICS, await authHeaders(app)).send({}).expect(401);
      await post(LOGS, await authHeaders(app)).send({}).expect(401);
    });

    it('does not accept the ingest token on a normal protected endpoint', async () => {
      await request(app.getHttpServer()).get('/api/v1/projects').set(auth).expect(401);
      await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth).expect(401);
      await request(app.getHttpServer()).get('/api/v1/usage').set(auth).expect(401);
    });

    it('answers 415 for protobuf and other media types once authenticated', async () => {
      await request(app.getHttpServer()).post(LOGS).set(auth).set('Content-Type', 'application/x-protobuf').send(Buffer.from([0x0a, 0x00])).expect(415);
      await request(app.getHttpServer()).post(METRICS).set(auth).set('Content-Type', 'text/plain').send('x').expect(415);
      // Credentials are checked before the media type.
      await request(app.getHttpServer()).post(LOGS).set('Content-Type', 'application/x-protobuf').send(Buffer.from([1])).expect(401);
    });
  });

  describe('limits', () => {
    it('answers 413 above 5 MB and accepts a 1 MB body', async () => {
      const big = (mb: number) => JSON.stringify(logsRequest([otherEvent()], { 'x.pad': str('x'.repeat(mb * 1024 * 1024)) }));
      await post(LOGS).send(big(1)).expect(200);
      await post(LOGS).send(big(6)).expect(413);
      await post(METRICS).send(JSON.stringify({ resourceMetrics: [], pad: 'x'.repeat(6 * 1024 * 1024) })).expect(413);
    });

    it('does not buffer large bodies without the token', async () => {
      const res = await post(LOGS, {}).send(JSON.stringify({ pad: 'x'.repeat(200 * 1024) }));
      expect(res.status).toBe(401);
    });

    it('answers 400 for malformed JSON and envelopes', async () => {
      await post(LOGS).send('{not json').expect(400);
      await post(LOGS).send(JSON.stringify([])).expect(400);
      await post(LOGS).send(JSON.stringify({ resourceLogs: 'x' })).expect(400);
      await post(METRICS).send(JSON.stringify({ resourceMetrics: 'x' })).expect(400);
    });
  });

  describe('logs', () => {
    it('stores exactly the api_request rows, allowlisted, and answers a valid OTLP response', async () => {
      const session = `s-${randomUUID()}`;
      const spy = vi.spyOn(Logger.prototype, 'log');
      const logs = [vi.spyOn(Logger.prototype, 'warn'), vi.spyOn(Logger.prototype, 'error'), vi.spyOn(Logger.prototype, 'debug'), spy];
      const res = await post(LOGS).send(uniqueLogs(session)).expect(200).expect('Content-Type', /application\/json/);
      expect(res.body).toEqual({});

      const out = await stored(session);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({
        runId: null, jobId: null, sessionId: session, model: 'claude-synthetic-1',
        inputTokens: 120, outputTokens: 45, cacheReadTokens: 3000, cacheCreationTokens: 800,
        costUsd: 0.0123, durationMs: 2400, serviceVersion: '9.9.9-synthetic', organizationId: 'org-synthetic',
      });
      expect(out[0].eventAt).toBe('2023-11-14T22:13:20.123Z');
      expect(out[1]).toMatchObject({ model: 'claude-synthetic-2', costUsd: null, durationMs: null, cacheReadTokens: 0 });

      // Nothing sensitive in the persisted rows or in any log line.
      const persisted = JSON.stringify(await rows.find({ where: { sessionId: session } }));
      for (const s of SENSITIVE) expect(persisted).not.toContain(s);
      expect(persisted).not.toContain('SECRET-HOST');
      for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toContain('SECRET');
      vi.restoreAllMocks();
    });

    it('reports rejected records as partial success and stores the valid ones', async () => {
      const session = `s-${randomUUID()}`;
      const bad = apiRequest({ attributes: { 'session.id': str(session), input_tokens: int(-5), 'event.sequence': int(9) } });
      const res = await post(LOGS).send(uniqueLogs(session, [bad])).expect(200);
      expect(res.body.partialSuccess.rejectedLogRecords).toBe(1);
      expect(JSON.stringify(res.body)).not.toContain('SECRET');
      expect(await stored(session)).toHaveLength(2);
    });

    it('is idempotent for retries, rebatching and concurrent duplicates', async () => {
      const session = `s-${randomUUID()}`;
      const body = uniqueLogs(session);
      await post(LOGS).send(body).expect(200);
      await post(LOGS).send(body).expect(200);
      expect(await stored(session)).toHaveLength(2);

      // Rebatched: the same events in different requests and order.
      const [a, , b] = (body.resourceLogs[0].scopeLogs[0].logRecords as unknown[]);
      await post(LOGS).send(logsRequest([b])).expect(200);
      await post(LOGS).send(logsRequest([b, a])).expect(200);
      expect(await stored(session)).toHaveLength(2);

      // Concurrent first delivery of a new session.
      const s2 = `s-${randomUUID()}`;
      const concurrent = uniqueLogs(s2);
      const results = await Promise.all(Array.from({ length: 6 }, () => post(LOGS).send(concurrent)));
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(await stored(s2)).toHaveLength(2);
    });

    it('keeps distinct same-timestamp events without a producer sequence', async () => {
      const session = `s-${randomUUID()}`;
      const mk = (input: number) => apiRequest({ timeUnixNano: '1700000000000000000', attributes: { 'session.id': str(session), 'event.sequence': null, input_tokens: int(input) } });
      await post(LOGS).send(logsRequest([mk(1), mk(2)])).expect(200);
      await post(LOGS).send(logsRequest([mk(2)])).expect(200);
      expect((await stored(session)).map((r) => r.inputTokens).sort()).toEqual([1, 2]);
    });

    it('does not attribute rows, even when a run with the same session exists', async () => {
      const session = `s-${randomUUID()}`;
      const run = await app.get(RunService).create({ jobId: randomUUID(), projectId: randomUUID(), repoId: randomUUID(), attempt: 1 });
      await app.get(RunService).markFired(run.id, { sessionId: session, sessionUrl: 'https://example.invalid/s' });
      await post(LOGS).send(uniqueLogs(session)).expect(200);
      const out = await stored(session);
      expect(out).toHaveLength(2);
      expect(out.every((r) => r.runId === null && r.jobId === null)).toBe(true);
    });

    it('acknowledges storage failures with 503 instead of success', async () => {
      const session = `s-${randomUUID()}`;
      const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const manager = app.get(DataSource).manager;
      const tx = vi.spyOn(manager, 'transaction').mockRejectedValueOnce(new Error('boom SECRET value'));
      const res = await post(LOGS).send(uniqueLogs(session)).expect(503);
      expect(JSON.stringify(res.body)).not.toContain('SECRET');
      expect(JSON.stringify(err.mock.calls)).not.toContain('SECRET');
      expect(await stored(session)).toHaveLength(0);
      tx.mockRestore();
      err.mockRestore();
      // The exporter's retry then succeeds.
      await post(LOGS).send(uniqueLogs(session)).expect(200);
      expect(await stored(session)).toHaveLength(2);
    });
  });

  describe('metrics', () => {
    it('acknowledges without writing usage', async () => {
      const before = await rows.count();
      const metrics = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { dataPoints: [{ asInt: '5', attributes: [] }] } }] }] }] };
      const res = await post(METRICS).send(metrics).expect(200).expect('Content-Type', /application\/json/);
      expect(res.body).toEqual({});
      await post(METRICS).send({}).expect(200);
      expect(await rows.count()).toBe(before);
    });
  });
});

describe('OTLP ingest configuration (e2e)', () => {
  afterEach(() => {
    delete process.env.OTEL_INGEST_TOKEN;
    delete process.env.OTEL_INGEST_RATE_LIMIT;
  });

  const wellFormed = () => JSON.stringify(sampleLogsRequest());

  async function disabledWith(token: string | undefined) {
    if (token === undefined) delete process.env.OTEL_INGEST_TOKEN;
    else process.env.OTEL_INGEST_TOKEN = token;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const app = await createApp();
    try {
      const send = (path: string, headers: Record<string, string>) =>
        request(app.getHttpServer()).post(path).set(headers).set('Content-Type', 'application/json').send(wellFormed());
      for (const headers of [{}, { Authorization: `Bearer ${token ?? 'x'}` }]) {
        await send(LOGS, headers).expect(404);
        await send(METRICS, headers).expect(404);
      }
      // The rest of the API keeps working.
      await request(app.getHttpServer()).get('/api/health').expect(200);
      return JSON.stringify(warn.mock.calls);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  }

  it('answers 404 on both routes without OTEL_INGEST_TOKEN', async () => {
    await disabledWith(undefined);
  });

  it('fails closed for a token shorter than 32 characters, with a warning that does not contain it', async () => {
    const warned = await disabledWith('too-short-secret');
    expect(warned).toContain('OTEL_INGEST_TOKEN');
    expect(warned).not.toContain('too-short-secret');
  });

  it('fails closed for a gk_ shaped token', async () => {
    const secret = `gk_${'a'.repeat(40)}`;
    const warned = await disabledWith(secret);
    expect(warned).not.toContain(secret);
  });

  it('throttles each route with 429 once the limit is used up', async () => {
    process.env.OTEL_INGEST_TOKEN = TOKEN;
    process.env.OTEL_INGEST_RATE_LIMIT = '3';
    const app = await createApp();
    try {
      const send = (path: string) => request(app.getHttpServer()).post(path).set({ Authorization: `Bearer ${TOKEN}` }).set('Content-Type', 'application/json').send({});
      for (let i = 0; i < 3; i++) await send(METRICS).expect(200);
      const limited = await send(METRICS).expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      // The limit is per route.
      await send(LOGS).expect(200);
    } finally {
      await app.close();
    }
  });

  it('keeps requiring the ingest token with AUTH_ENABLED=false, without opening it up', async () => {
    process.env.OTEL_INGEST_TOKEN = TOKEN;
    process.env.AUTH_ENABLED = 'false';
    delete process.env.JWT_SECRET;
    const app = await createApp();
    try {
      await request(app.getHttpServer()).post(LOGS).set('Content-Type', 'application/json').send({}).expect(401);
      await request(app.getHttpServer()).post(LOGS).set({ Authorization: `Bearer ${TOKEN}` }).set('Content-Type', 'application/json').send({}).expect(200);
    } finally {
      await app.close();
      process.env.AUTH_ENABLED = saved.AUTH_ENABLED as string;
      if (saved.AUTH_ENABLED === undefined) delete process.env.AUTH_ENABLED;
      process.env.JWT_SECRET = saved.JWT_SECRET as string;
      if (saved.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    }
  });
});
