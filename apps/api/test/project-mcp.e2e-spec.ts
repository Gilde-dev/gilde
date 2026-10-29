import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { ProjectMcpConnector } from './../src/project-mcp/project-mcp.connector.js';
import { ProjectMcpService } from './../src/project-mcp/project-mcp.service.js';
import { UserService } from './../src/user/user.service.js';
import { createApiKey, createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { startFakeMcpServer, type FakeMcpServer } from './helpers/fake-mcp-server.js';

const URL_ = 'https://mcp.example.com/mcp';
const TOKEN = 'mcp-SUPERSECRETVALUE-9z8y';

/** Sends the real SDK client to the local fake server instead of the registered https URL. */
class RedirectingConnector extends ProjectMcpConnector {
  static target = '';
  static seenUrls: string[] = [];
  override listTools(url: string, token: string | null, timeoutMs?: number) {
    RedirectingConnector.seenUrls.push(url);
    return super.listTools(RedirectingConnector.target, token, timeoutMs);
  }
}

describe('Project MCP servers (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let projectId: string;
  let fake: FakeMcpServer | undefined;
  const previousKey = process.env.EXECUTOR_SECRET_KEY;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const base = () => `/api/v1/projects/${projectId}/mcp-servers`;
  const body = (over: object = {}) => ({ name: 'Notion', url: URL_, token: TOKEN, ...over });

  async function boot(key: string | undefined) {
    if (key === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = key;
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProjectMcpConnector).useClass(RedirectingConnector)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = randomBytes(4).toString('hex');
    projectId = (await http().post('/api/v1/projects').set(as(ann)).send({ name: `P ${slug}`, slug: `p-${slug}` })).body.id;
  }

  async function useFake(options: Parameters<typeof startFakeMcpServer>[0] = {}) {
    fake = await startFakeMcpServer(options);
    RedirectingConnector.target = fake.url;
    RedirectingConnector.seenUrls = [];
  }

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    await app.close();
    if (previousKey === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = previousKey;
  });

  describe('with EXECUTOR_SECRET_KEY', () => {
    beforeEach(() => boot(randomBytes(32).toString('base64')));

    const create = async (over: object = {}) => (await http().post(base()).set(as(ann)).send(body(over)).expect(201)).body;

    it('creates, lists, reads, replaces and deletes a server', async () => {
      const created = await create();
      expect(created).toMatchObject({
        projectId, name: 'Notion', url: URL_, hasToken: true, tokenLast4: '9z8y', enabled: true, unattendedEnabled: false,
        lastError: null, callCount: 0, errorCount: 0,
      });
      expect((await http().get(base()).set(as(ann)).expect(200)).body).toEqual([created]);
      expect((await http().get(`${base()}/${created.id}`).set(as(ann)).expect(200)).body).toMatchObject({ ...created, tools: [] });

      const replaced = await http().put(`${base()}/${created.id}`).set(as(ann))
        .send({ name: 'Wiki', url: 'https://wiki.example.com/mcp', enabled: false, unattendedEnabled: true }).expect(200);
      expect(replaced.body).toMatchObject({ name: 'Wiki', url: 'https://wiki.example.com/mcp', enabled: false, unattendedEnabled: true, tokenLast4: '9z8y' });

      await http().delete(`${base()}/${created.id}`).set(as(ann)).expect(204);
      await http().get(`${base()}/${created.id}`).set(as(ann)).expect(404);
    });

    it('allows a server without a token', async () => {
      const created = await create({ token: undefined });
      expect(created).toMatchObject({ hasToken: false, tokenLast4: null });
    });

    it('validates the URL: https only, public, no credentials', async () => {
      for (const url of ['http://mcp.example.com', 'https://user:pw@mcp.example.com', 'https://localhost/mcp', 'https://127.0.0.1/mcp',
        'https://10.0.0.5/mcp', 'https://169.254.169.254/latest', 'https://[::1]/mcp', 'ftp://x.example.com', 'not a url']) {
        await http().post(base()).set(as(ann)).send(body({ url })).expect(400);
      }
    });

    it('refuses a duplicate name in the project with 409, and scopes servers to their project', async () => {
      const created = await create();
      await http().post(base()).set(as(ann)).send(body()).expect(409);
      const other = (await http().post('/api/v1/projects').set(as(ann)).send({ name: 'Other', slug: `o-${randomBytes(3).toString('hex')}` })).body.id;
      await http().post(`/api/v1/projects/${other}/mcp-servers`).set(as(ann)).send(body()).expect(201);
      await http().get(`/api/v1/projects/${other}/mcp-servers/${created.id}`).set(as(ann)).expect(404);
      await http().delete(`/api/v1/projects/${other}/mcp-servers/${created.id}`).set(as(ann)).expect(404);
      await http().get(`/api/v1/projects/00000000-0000-4000-8000-000000000000/mcp-servers`).set(as(ann)).expect(404);
    });

    it('refuses writes by API key and by bot, while an API key may still read', async () => {
      const created = await create();
      const viaKey = { Authorization: `Bearer ${await createApiKey(app, ann)}` };
      await http().get(base()).set(viaKey).expect(200);
      await http().post(base()).set(viaKey).send(body({ name: 'K' })).expect(401);
      await http().put(`${base()}/${created.id}`).set(viaKey).send({ name: 'x', url: URL_, enabled: true, unattendedEnabled: false }).expect(401);
      await http().put(`${base()}/${created.id}/token`).set(viaKey).send({ token: 'abcdefgh' }).expect(401);
      await http().post(`${base()}/${created.id}/test`).set(viaKey).expect(401);
      await http().put(`${base()}/${created.id}/tools`).set(viaKey).send({ tools: [] }).expect(401);
      await http().delete(`${base()}/${created.id}`).set(viaKey).expect(401);

      const bot = await createTestUser(app, { name: 'Bot' });
      await app.get(UserService).markBot(bot.email);
      await http().post(base()).set(as(bot)).send(body({ name: 'B' })).expect(403);
      await http().post(`${base()}/${created.id}/test`).set(as(bot)).expect(403);
      await http().delete(`${base()}/${created.id}`).set(as(bot)).expect(403);

      const scout = await createTestUser(app, { name: 'Scout' });
      const previous = process.env.SCOUT_USER_EMAIL;
      process.env.SCOUT_USER_EMAIL = scout.email;
      try {
        await http().post(base()).set(as(scout)).send(body({ name: 'S' })).expect(403);
      } finally {
        if (previous === undefined) delete process.env.SCOUT_USER_EMAIL;
        else process.env.SCOUT_USER_EMAIL = previous;
      }
      await http().get(base()).expect(401);
      expect((await http().get(base()).set(as(ann))).body).toHaveLength(1);
    });

    it('stores the token encrypted under its own key version and never returns it', async () => {
      const created = await create();
      const responses = [
        JSON.stringify(created),
        JSON.stringify((await http().get(base()).set(as(ann))).body),
        JSON.stringify((await http().get(`${base()}/${created.id}`).set(as(ann))).body),
        JSON.stringify((await http().put(`${base()}/${created.id}`).set(as(ann))
          .send({ name: 'x', url: URL_, enabled: true, unattendedEnabled: false })).body),
        JSON.stringify((await http().post(base()).set(as(ann)).send(body({ name: 'Bad', url: 'http://x' }))).body),
        JSON.stringify((await http().put(`${base()}/${created.id}/token`).set(as(ann)).send({ token: 'has space' })).body),
      ];
      for (const r of responses) {
        expect(r).not.toContain('SUPERSECRET');
        expect(r).not.toMatch(/ciphertext|tokenIv|tokenTag|token_iv|keyVersion/i);
      }
      const row = (await app.get(DataSource).query('SELECT * FROM project_mcp_servers WHERE id = ?', [created.id]))[0];
      expect(JSON.stringify(row)).not.toContain('SUPERSECRET');
      expect(row.token_ciphertext).toEqual(expect.any(String));
      expect(row.key_version).toBe(1);
      expect(await app.get(ProjectMcpService).revealToken(created.id)).toBe(TOKEN);
    });

    it('replaces only the token, with a new IV', async () => {
      const created = await create();
      const iv = async () => (await app.get(DataSource).query('SELECT token_iv FROM project_mcp_servers WHERE id = ?', [created.id]))[0].token_iv;
      const before = await iv();
      await http().put(`${base()}/${created.id}/token`).set(as(ann)).send({ token: 'new-token-abcd' }).expect(204);
      expect(await iv()).not.toBe(before);
      expect((await http().get(`${base()}/${created.id}`).set(as(ann))).body).toMatchObject({ tokenLast4: 'abcd', name: 'Notion' });
      expect(await app.get(ProjectMcpService).revealToken(created.id)).toBe('new-token-abcd');
    });

    describe('test connection and allowlist', () => {
      it('lists the tools with default modes from annotations, calls none, and sends the token', async () => {
        await useFake({ token: TOKEN });
        const created = await create();
        const res = await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200);
        expect(res.body).toEqual({
          ok: true, errorKind: null, message: null,
          tools: [
            { name: 'create_page', description: 'Create a page', mode: 'write', allowed: false },
            { name: 'search', description: 'Search the knowledge base', mode: 'read', allowed: false },
          ],
        });
        expect(fake!.calls).toEqual([]);
        expect(fake!.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
        expect(RedirectingConnector.seenUrls).toEqual([URL_]);
        const detail = (await http().get(`${base()}/${created.id}`).set(as(ann))).body;
        expect(detail.lastTestedAt).toEqual(expect.any(String));
        expect(detail.lastError).toBeNull();
      });

      it('replaces the allowlist and modes, and a re-test keeps the choices of tools that still exist', async () => {
        await useFake();
        const created = await create({ token: undefined });
        await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200);
        const saved = await http().put(`${base()}/${created.id}/tools`).set(as(ann))
          .send({ tools: [{ name: 'search', mode: 'read', allowed: true }, { name: 'create_page', mode: 'write', allowed: false }] }).expect(200);
        expect(saved.body).toEqual([
          { name: 'create_page', description: 'Create a page', mode: 'write', allowed: false },
          { name: 'search', description: 'Search the knowledge base', mode: 'read', allowed: true },
        ]);

        await fake!.close();
        await useFake({ tools: [
          { name: 'search', description: 'Changed text', readOnly: false },
          { name: 'list_pages', readOnly: true },
        ] });
        const retest = (await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200)).body;
        expect(retest.tools).toEqual([
          { name: 'list_pages', description: 'list_pages', mode: 'read', allowed: false },
          { name: 'search', description: 'Changed text', mode: 'read', allowed: true },
        ]);

        // Tools that are not listed lose their allowance; the mode of a listed tool can be changed by the human.
        const second = await http().put(`${base()}/${created.id}/tools`).set(as(ann))
          .send({ tools: [{ name: 'list_pages', mode: 'write', allowed: true }] }).expect(200);
        expect(second.body).toEqual([
          { name: 'list_pages', description: 'list_pages', mode: 'write', allowed: true },
          { name: 'search', description: 'Changed text', mode: 'read', allowed: false },
        ]);
        await http().put(`${base()}/${created.id}/tools`).set(as(ann)).send({ tools: [{ name: 'nope', mode: 'read', allowed: true }] }).expect(400);
        await http().put(`${base()}/${created.id}/tools`).set(as(ann))
          .send({ tools: [{ name: 'search', mode: 'read', allowed: true }, { name: 'search', mode: 'read', allowed: true }] }).expect(400);
        expect(fake!.calls).toEqual([]);
      });

      it.each([
        ['unauthorized', 'auth'],
        ['forbidden', 'auth'],
        ['html', 'not_mcp'],
      ] as const)('reports a %s server as %s and records it as the last error', async (mode, kind) => {
        await useFake({ mode });
        const created = await create();
        const res = (await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200)).body;
        expect(res).toMatchObject({ ok: false, errorKind: kind, message: expect.any(String) });
        expect(JSON.stringify(res)).not.toContain('SUPERSECRET');
        const detail = (await http().get(`${base()}/${created.id}`).set(as(ann))).body;
        expect(detail.lastError).toBe(res.message);
        expect(detail.lastErrorAt).toEqual(expect.any(String));
      });

      it('reports an unreachable server and keeps the known tools', async () => {
        await useFake();
        const created = await create({ token: undefined });
        await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200);
        await fake!.close();
        const res = (await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200)).body;
        expect(res).toMatchObject({ ok: false, errorKind: 'unreachable' });
        expect(res.tools).toHaveLength(2);
      });

      it('audits every change with who and what, never the token', async () => {
        await useFake();
        const created = await create();
        await http().put(`${base()}/${created.id}`).set(as(ann)).send({ name: 'Notion', url: URL_, enabled: false, unattendedEnabled: false }).expect(200);
        await http().put(`${base()}/${created.id}/token`).set(as(ann)).send({ token: 'another-secret-zzzz' }).expect(204);
        await http().post(`${base()}/${created.id}/test`).set(as(ann)).expect(200);
        await http().put(`${base()}/${created.id}/tools`).set(as(ann)).send({ tools: [{ name: 'search', mode: 'read', allowed: true }] }).expect(200);

        const audit = (await http().get(`${base()}/${created.id}`).set(as(ann))).body.audit as { action: string; actorId: string; actorEmail: string; changes: object; createdAt: string }[];
        expect(audit.map((a) => a.action).reverse()).toEqual(['created', 'updated', 'token_replaced', 'tested', 'tools_updated']);
        expect(audit.every((a) => a.actorId === ann.id && a.actorEmail === ann.email && a.createdAt)).toBe(true);
        const byAction = Object.fromEntries(audit.map((a) => [a.action, a.changes]));
        expect(byAction.updated).toEqual({ enabled: { from: true, to: false } });
        expect(byAction.tools_updated).toEqual({ tools: [{ tool: 'search', allowed: { from: false, to: true } }] });
        const everything = JSON.stringify(audit) + JSON.stringify(await app.get(DataSource).query('SELECT * FROM project_mcp_audit'));
        expect(everything).not.toContain('SUPERSECRET');
        expect(everything).not.toContain('another-secret-zzzz');
        expect(everything).not.toContain('9z8y');

        await http().delete(`${base()}/${created.id}`).set(as(ann)).expect(204);
        const rows = await app.get(DataSource).query('SELECT action FROM project_mcp_audit WHERE server_id = ? ORDER BY created_at', [created.id]);
        expect(rows.at(-1).action).toBe('deleted');
      });
    });

    it('counts calls and errors per server, internally', async () => {
      const created = await create();
      const service = app.get(ProjectMcpService);
      await service.recordCall(created.id, null);
      await service.recordCall(created.id, 'The server did not respond in time');
      expect((await http().get(base()).set(as(ann))).body[0]).toMatchObject({
        callCount: 2, errorCount: 1, lastError: 'The server did not respond in time',
      });
    });
  });

  describe('without EXECUTOR_SECRET_KEY', () => {
    beforeEach(() => boot(undefined));

    it('answers 503 when a token is stored, and still allows a server without a token', async () => {
      await http().post(base()).set(as(ann)).send(body()).expect(503);
      const created = (await http().post(base()).set(as(ann)).send(body({ token: undefined })).expect(201)).body;
      await http().put(`${base()}/${created.id}/token`).set(as(ann)).send({ token: 'abcdefgh' }).expect(503);
      expect((await http().get(base()).set(as(ann)).expect(200)).body).toHaveLength(1);
    });
  });
});
