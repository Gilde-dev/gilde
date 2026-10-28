// MCP is enabled for this file only; mcp-disabled.e2e-spec.ts covers the default. The module reads the environment when
// AppModule is imported, so the import is dynamic.
process.env.MCP_ENABLED = 'true';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createTestUser, tokenFor, createApiKey, type TestUser } from './helpers/auth.js';

const ACCEPT = 'application/json, text/event-stream';

describe('MCP server (e2e)', () => {
  let app: INestApplication;
  let user: TestUser;
  let key: string;
  let projectId: string;
  let repoId: string;

  const http = () => request(app.getHttpServer());
  const rpc = (body: object, auth: string | null = `Bearer ${key}`) => {
    const r = http().post('/api/v1/mcp').set('Accept', ACCEPT).set('Content-Type', 'application/json');
    if (auth) r.set('Authorization', auth);
    return r.send(body);
  };
  const call = async (name: string, args: object, auth?: string | null) => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, auth);
    expect(res.status).toBe(200);
    const result = res.body.result as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: result.isError === true, text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
  };

  beforeAll(async () => {
    const { AppModule } = await import('./../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    user = await createTestUser(app, { name: 'Operator' });
    key = await createApiKey(app, user);
    const jwt = { Authorization: `Bearer ${tokenFor(app, user)}` };
    projectId = (await http().post('/api/v1/projects').set(jwt).send({ slug: `mcp-${Date.now()}`, name: 'MCP project' }).expect(201)).body.id;
    repoId = (await http().post(`/api/v1/projects/${projectId}/repos`).set(jwt).send({ fullName: `acme/mcp-${Date.now()}` }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers initialize statelessly with JSON and no session id', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(res.body.result.serverInfo.name).toBe('gilde');
  });

  it('lists exactly the 23 tools without any prior session', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect((res.body.result.tools as { name: string }[]).map((t) => t.name).sort()).toHaveLength(23);
  });

  it('requires an Accept header that allows JSON and event streams', async () => {
    const res = await http().post('/api/v1/mcp').set('Authorization', `Bearer ${key}`).set('Accept', 'text/plain').send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(res.status).toBe(406);
  });

  it('refuses requests without credentials or with a bad key at the HTTP boundary', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null).expect(401);
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer gk_00000000_' + '0'.repeat(64)).expect(401);
  });

  it('answers GET and DELETE with 405: no stream, no session', async () => {
    await http().get('/api/v1/mcp').set('Authorization', `Bearer ${key}`).expect(405);
    await http().delete('/api/v1/mcp').set('Authorization', `Bearer ${key}`).expect(405);
  });

  it('serves a read call', async () => {
    const r = await call('listProjects', {});
    expect(r.isError).toBe(false);
    expect(r.json().map((p: { id: string }) => p.id)).toContain(projectId);
  });

  it('creates a triage job attributed to the key owner and ignores spoofed fields', async () => {
    const other = await createTestUser(app);
    const r = await call('createJob', { repoId, title: 'Add a thing', task: 'Do the thing properly please', acceptanceCriteria: ['It works well'], status: 'queued', createdBy: other.id, createdById: other.id, isBot: false });
    expect(r.isError).toBe(false);
    const created = r.json() as { jobId: string; status: string };
    expect(created.status).toBe('triage');
    const jwt = { Authorization: `Bearer ${tokenFor(app, user)}` };
    const job = (await http().get(`/api/v1/jobs/${created.jobId}`).set(jwt).expect(200)).body;
    expect(job.status).toBe('triage');
    expect(job.createdBy?.id ?? job.createdById).toBe(user.id);
  });

  it('works with a JWT as well', async () => {
    const r = await call('listProjects', {}, `Bearer ${tokenFor(app, user)}`);
    expect(r.isError).toBe(false);
  });

  it('keeps other routes reachable, Mastra included', async () => {
    const jwt = { Authorization: `Bearer ${tokenFor(app, user)}` };
    await http().get('/api/v1/projects').set(jwt).expect(200);
    await http().get('/api/health').expect(200);
    await http().get('/api/v1/copilot/status').set(jwt).expect(200);
    // Mastra answers 503 without a co-pilot configuration, but it still owns its prefix.
    const mastra = await http().get('/api/v1/mastra/agents').set(jwt);
    expect([200, 401, 403, 503]).toContain(mastra.status);
  });

  it('refuses a bot key with a tool error', async () => {
    const bot = await createTestUser(app);
    const botKey = await createApiKey(app, bot);
    await app.get(DataSource).query('UPDATE users SET is_bot = 1 WHERE id = ?', [bot.id]);
    const r = await call('listProjects', {}, `Bearer ${botKey}`);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Not allowed');
  });
});
