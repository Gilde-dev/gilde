import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { ProjectMcpConnector } from './../src/project-mcp/project-mcp.connector.js';
import { ProjectMcpToolsService } from './../src/project-mcp/project-mcp-tools.service.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { startFakeMcpServer, type FakeMcpServer } from './helpers/fake-mcp-server.js';

const URL_ = 'https://mcp.example.com/mcp';
const TOKEN = 'mcp-SUPERSECRETVALUE-9z8y';

/** Sends the real SDK client to the local fake server instead of the registered https URL. */
class RedirectingConnector extends ProjectMcpConnector {
  static target = '';
  override listTools(_url: string, token: string | null, timeoutMs?: number) {
    return super.listTools(RedirectingConnector.target, token, timeoutMs);
  }
  override openSession(_url: string, token: string | null, timeoutMs: number) {
    return super.openSession(RedirectingConnector.target, token, timeoutMs);
  }
}

type Tool = { execute: (input: unknown, context: unknown) => Promise<Record<string, unknown>>; requireApproval?: boolean };

describe('Project MCP tools (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let projectId: string;
  let fake: FakeMcpServer;
  const previousKey = process.env.EXECUTOR_SECRET_KEY;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const base = () => `/api/v1/projects/${projectId}/mcp-servers`;

  async function register(over: object = {}) {
    const created = (await http().post(base()).set(as(ann)).send({ name: 'Notion', url: URL_, token: TOKEN, ...over }).expect(201)).body;
    await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200);
    return created.id as string;
  }
  const allow = (id: string, tools: { name: string; allowed: boolean; mode: 'read' | 'write' }[]) =>
    http().put(`${base()}/${id}/tools`).set(as(ann)).send({ tools }).expect(200);
  const buildTools = async (audience: 'copilot' | 'unattended') =>
    (await app.get(ProjectMcpToolsService).buildTools(projectId, audience)) as unknown as Record<string, Tool>;
  const server = async (id: string) => (await http().get(`${base()}/${id}`).set(as(ann)).expect(200)).body;

  beforeEach(async () => {
    process.env.EXECUTOR_SECRET_KEY = randomBytes(32).toString('base64');
    fake = await startFakeMcpServer({ token: TOKEN, results: { search: 'Roadmap: Q4 launch' } });
    RedirectingConnector.target = fake.url;
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProjectMcpConnector).useClass(RedirectingConnector)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = randomBytes(4).toString('hex');
    projectId = (await http().post('/api/v1/projects').set(as(ann)).send({ name: `P ${slug}`, slug: `p-${slug}` })).body.id;
  });

  afterEach(async () => {
    await app.get(ProjectMcpToolsService).onModuleDestroy();
    await fake.close();
    await app.close();
    if (previousKey === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = previousKey;
  });

  it('builds the tools from the registry, runs a read tool with the decrypted token and counts the call', async () => {
    const id = await register();
    await allow(id, [{ name: 'search', allowed: true, mode: 'read' }, { name: 'create_page', allowed: true, mode: 'write' }]);
    fake.calls.length = 0;

    const copilot = await buildTools('copilot');
    expect(Object.keys(copilot).sort()).toEqual(['mcp__Notion__create_page', 'mcp__Notion__search']);
    expect(copilot.mcp__Notion__create_page.requireApproval).toBe(true);

    const result = await copilot.mcp__Notion__search.execute({ query: 'roadmap' }, {});
    expect(String(result.content)).toContain('Roadmap: Q4 launch');
    expect(String(result.content)).toContain('untrusted="true"');
    expect(fake.calls).toEqual(['search']);
    expect(fake.authorizations.at(-1)).toBe(`Bearer ${TOKEN}`);
    expect(await server(id)).toMatchObject({ callCount: 1, errorCount: 0, lastError: null });
  });

  it('gives unattended agents nothing until the server is opted in, then only read tools', async () => {
    const id = await register();
    await allow(id, [{ name: 'search', allowed: true, mode: 'read' }, { name: 'create_page', allowed: true, mode: 'write' }]);
    expect(Object.keys(await buildTools('unattended'))).toEqual([]);

    const current = await server(id);
    await http().put(`${base()}/${id}`).set(as(ann)).send({ name: current.name, url: current.url, enabled: true, unattendedEnabled: true }).expect(200);
    expect(Object.keys(await buildTools('unattended'))).toEqual(['mcp__Notion__search']);
  });

  it('leaves out a disabled server and tools that are not allowed', async () => {
    const id = await register();
    await allow(id, [{ name: 'search', allowed: false, mode: 'read' }]);
    expect(Object.keys(await buildTools('copilot'))).toEqual([]);
    await allow(id, [{ name: 'search', allowed: true, mode: 'read' }]);
    const current = await server(id);
    await http().put(`${base()}/${id}`).set(as(ann)).send({ name: current.name, url: current.url, enabled: false, unattendedEnabled: false }).expect(200);
    expect(Object.keys(await buildTools('copilot'))).toEqual([]);
  });

  it('records a failing call per server, without the token', async () => {
    await fake.close();
    fake = await startFakeMcpServer({ token: TOKEN, failing: ['search'], results: { search: `boom ${TOKEN}` } });
    RedirectingConnector.target = fake.url;
    const id = await register();
    await allow(id, [{ name: 'search', allowed: true, mode: 'read' }]);

    const result = await (await buildTools('copilot')).mcp__Notion__search.execute({}, {});
    expect(result).toEqual({ error: 'The MCP server reported an error for this tool call' });
    const after = await server(id);
    expect(after).toMatchObject({ callCount: 1, errorCount: 1, lastError: 'The MCP server reported an error for this tool call' });
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });

  it('skips a server that is down when building the set and records why', async () => {
    const id = await register();
    await allow(id, [{ name: 'search', allowed: true, mode: 'read' }]);
    await fake.close();
    app.get(ProjectMcpToolsService).limits = { ...app.get(ProjectMcpToolsService).limits, timeoutMs: 500, cacheTtlMs: 0 };

    expect(Object.keys(await buildTools('copilot'))).toEqual([]);
    const after = await server(id);
    expect(after.errorCount).toBe(1);
    expect(typeof after.lastError).toBe('string');
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });
});
