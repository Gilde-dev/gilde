import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';
import { REFINE_TOOL_NAMES } from './../src/copilot/verfijner.tools.js';
import { SCOUT_TOOL_NAMES } from './../src/copilot/verkenner.tools.js';
import { PLAN_TOOL_NAMES } from './../src/copilot/werkmeester.tools.js';
import { MCP_TOOL_NAMES } from './../src/mcp/mcp.tools.js';
import { AgentRuntimeService } from './../src/agent/agent-runtime.service.js';
import { UserService } from './../src/user/user.service.js';
import { createApiKey, createTestUser, tokenFor } from './helpers/auth.js';

type Agent = { id: string; status: string; reason: string | null; enabled: boolean; model: string | null; effectiveModel: string | null; botUserId: string | null; botUser: { id: string; email: string } | null; settings: Record<string, number>; fields: unknown[] };

describe('Agent settings (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const previous = { key: process.env.OPENAI_API_KEY, disabled: process.env.AGENTS_DISABLED };
  let human: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;

  async function bot(name = 'Agent Bot') {
    const user = await createTestUser(app, { name });
    await app.get(UserService).markBot(user.email);
    return user;
  }
  const get = async (id: string) => (await http().get(`/api/v1/agents/${id}`).set(bearer(token)).expect(200)).body as Agent;
  const put = (id: string, body: unknown, auth = token) => http().put(`/api/v1/agents/${id}/settings`).set(bearer(auth)).send(body as object);

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'sk-e2e-not-a-real-key';
    delete process.env.AGENTS_DISABLED;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    human = await createTestUser(app, { name: 'Operator' });
    token = tokenFor(app, human);
  });

  afterAll(async () => {
    await app.close();
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.key;
    if (previous.disabled === undefined) delete process.env.AGENTS_DISABLED; else process.env.AGENTS_DISABLED = previous.disabled;
  });

  it('requires authentication on every route', async () => {
    await http().get('/api/v1/agents').expect(401);
    await http().get('/api/v1/agents/gilde').expect(401);
    await http().get('/api/v1/agents/bot-users').expect(401);
    await http().get('/api/v1/agents/gilde/audit').expect(401);
    await http().get('/api/v1/agents/gilde/tools').expect(401);
    await http().get('/api/v1/agents/slack').expect(401);
    await http().put('/api/v1/agents/gilde/settings').send({}).expect(401);
  });

  it('lists the six agents with status, field definitions and no secret', async () => {
    const res = await http().get('/api/v1/agents').set(bearer(token)).expect(200);
    const agents = res.body as Agent[];
    expect(agents.map((a) => a.id)).toEqual(['gilde', 'verkenner', 'verfijner', 'werkmeester', 'mcp', 'coding']);
    for (const a of agents) {
      expect(['on', 'off', 'misconfigured', 'disabled_by_env']).toContain(a.status);
      expect(a.fields.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(res.body)).not.toContain('sk-e2e-not-a-real-key');
    expect(agents.find((a) => a.id === 'mcp')).toMatchObject({ settings: { dailyJobLimit: expect.any(Number) } });
  });

  it('answers 404 for an unknown agent', async () => {
    await http().get('/api/v1/agents/nobody').set(bearer(token)).expect(404);
    await http().get('/api/v1/agents/nobody/audit').set(bearer(token)).expect(404);
    await put('nobody', { enabled: false, botUserId: null, model: null, settings: {} }).expect(404);
  });

  it('lists only users marked as bots for the picker', async () => {
    const b = await bot('Picker Bot');
    const humanOnly = await createTestUser(app, { name: 'Not A Bot' });
    const res = await http().get('/api/v1/agents/bot-users').set(bearer(token)).expect(200);
    const ids = (res.body as Array<{ id: string }>).map((u) => u.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(humanOnly.id);
    expect(res.body[0]).toEqual({ id: expect.any(String), name: expect.any(String), email: expect.any(String) });
  });

  describe('changing settings of the Verfijner', () => {
    let original: Agent;
    beforeAll(async () => { original = await get('verfijner'); });
    afterAll(async () => {
      await put('verfijner', { enabled: original.enabled, botUserId: original.botUserId, model: original.model, settings: original.settings });
    });

    it('is a full replacement by a verified human, audited with old and new values, and takes effect at once', async () => {
      const b = await bot('Verfijner Bot');
      const before = await http().get('/api/v1/agents/verfijner/audit').set(bearer(token)).expect(200);
      const res = await put('verfijner', { enabled: true, botUserId: b.id, model: 'openai/e2e-model', settings: { dailyLimit: 3 } }).expect(200);
      expect(res.body).toMatchObject({ id: 'verfijner', enabled: true, model: 'openai/e2e-model', effectiveModel: 'openai/e2e-model', botUser: { id: b.id, email: b.email }, settings: { dailyLimit: 3 }, status: 'on', reason: null });
      expect(await app.get(AgentRuntimeService).refineSetup()).toMatchObject({ user: { id: b.id }, config: { dailyLimit: 3, model: 'openai/e2e-model' } });

      const audit = (await http().get('/api/v1/agents/verfijner/audit').set(bearer(token)).expect(200)).body as Array<{ field: string; oldValue: string | null; newValue: string | null; changedBy: { id: string; email: string } }>;
      expect(audit.length).toBeGreaterThan((before.body as unknown[]).length);
      const entry = audit.find((e) => e.field === 'settings.dailyLimit' && e.newValue === '3')!;
      expect(entry).toMatchObject({ oldValue: String(original.settings.dailyLimit), changedBy: { id: human.id, email: human.email } });
      expect(audit.find((e) => e.field === 'botUserId')).toMatchObject({ newValue: JSON.stringify(b.id) });
    });

    it('writes no audit entry for an unchanged replacement', async () => {
      const current = await get('verfijner');
      const before = ((await http().get('/api/v1/agents/verfijner/audit').set(bearer(token))).body as unknown[]).length;
      await put('verfijner', { enabled: current.enabled, botUserId: current.botUserId, model: current.model, settings: current.settings }).expect(200);
      expect(((await http().get('/api/v1/agents/verfijner/audit').set(bearer(token))).body as unknown[]).length).toBe(before);
    });

    it('rejects invalid values with field errors and changes nothing', async () => {
      const current = await get('verfijner');
      const res = await put('verfijner', { enabled: true, botUserId: current.botUserId, model: 'gpt-4', settings: { dailyLimit: 0, extra: 1 } }).expect(400);
      const paths = (res.body.issues as Array<{ path: string }>).map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['model', 'settings.dailyLimit', 'settings.extra']));
      expect(await get('verfijner')).toMatchObject({ settings: current.settings, model: current.model });
      await put('verfijner', { enabled: true, botUserId: current.botUserId, model: null }).expect(400); // not a full replacement
    });

    it('rejects a bot user that is not a bot, an unknown one, and none while switching on', async () => {
      const notBot = await createTestUser(app, { name: 'Human' });
      const current = await get('verfijner');
      const body = { enabled: true, model: null, settings: current.settings };
      expect((await put('verfijner', { ...body, botUserId: notBot.id }).expect(400)).body.issues).toEqual([{ path: 'botUserId', message: 'Choose a user that is marked as a bot' }]);
      expect((await put('verfijner', { ...body, botUserId: '00000000-0000-4000-8000-000000000000' }).expect(400)).body.issues[0].path).toBe('botUserId');
      expect((await put('verfijner', { ...body, botUserId: null }).expect(400)).body.issues[0].path).toBe('botUserId');
      expect((await put('mcp', { enabled: true, botUserId: notBot.id, model: null, settings: (await get('mcp')).settings }).expect(400)).body.issues[0]).toEqual({ path: 'botUserId', message: 'This agent has no bot user' });
    });

    it('shows an agent whose bot user lost its bot flag as misconfigured, and does not run it', async () => {
      const b = await bot('Soon Human');
      const current = await get('verfijner');
      await put('verfijner', { enabled: true, botUserId: b.id, model: 'openai/e2e-model', settings: current.settings }).expect(200);
      const users = app.get(UserService) as unknown as { users: { update(c: object, v: object): Promise<unknown> } };
      await users.users.update({ id: b.id }, { isBot: false });
      const agent = await get('verfijner');
      expect(agent.status).toBe('misconfigured');
      expect(agent.reason).toContain('is not marked as a bot');
      expect(await app.get(AgentRuntimeService).refineSetup()).toBeNull();
    });
  });

  describe('the Verkenner', () => {
    let original: Agent;
    let pilot: Agent;
    beforeAll(async () => { original = await get('verkenner'); pilot = await get('gilde'); });
    afterAll(async () => {
      await put('verkenner', { enabled: original.enabled, botUserId: original.botUserId, model: original.model, settings: original.settings });
      await put('gilde', { enabled: pilot.enabled, botUserId: null, model: pilot.model, settings: pilot.settings });
    });

    it('is reported on the co-pilot status route as on, and with the reason once its bot user is no longer a bot', async () => {
      const b = await bot('Scout Bot');
      await put('gilde', { enabled: true, botUserId: null, model: 'openai/e2e-main', settings: (await get('gilde')).settings }).expect(200);
      await put('verkenner', { enabled: true, botUserId: b.id, model: null, settings: original.settings }).expect(200);
      const status = () => http().get('/api/v1/copilot/status').set(bearer(token)).expect(200).then((r) => r.body as { scout: { enabled: boolean; model: string | null; disabledReason: string | null } });
      expect((await status()).scout).toEqual({ enabled: true, model: 'openai/e2e-main', disabledReason: null });

      const users = app.get(UserService) as unknown as { users: { update(c: object, v: object): Promise<unknown> } };
      await users.users.update({ id: b.id }, { isBot: false });
      const off = (await status()).scout;
      expect(off).toMatchObject({ enabled: false, model: null });
      expect(off.disabledReason).toContain('is not marked as a bot');
      expect(await app.get(AgentRuntimeService).scoutSetup()).toBeNull();
    });
  });

  describe('tools and the Slack bot', () => {
    type Tools = { agent: string; kind: string; tools: Array<{ name: string; access: string; needsApproval: boolean }>; note: string | null; projectTools: unknown[] };
    const tools = async (id: string) => (await http().get(`/api/v1/agents/${id}/tools`).set(bearer(token)).expect(200)).body as Tools;

    it('lists the exact allowlist of each agent, the same names the agents are built with', async () => {
      const names = async (id: string) => (await tools(id)).tools.map((t) => t.name).sort();
      expect(await names('verkenner')).toEqual([...SCOUT_TOOL_NAMES].sort());
      expect(await names('verfijner')).toEqual([...REFINE_TOOL_NAMES].sort());
      expect(await names('werkmeester')).toEqual([...PLAN_TOOL_NAMES].sort());
      expect(await names('mcp')).toEqual([...MCP_TOOL_NAMES].sort());
      const copilot = await tools('gilde');
      expect(copilot.kind).toBe('allowlist');
      expect(copilot.tools.filter((t) => t.needsApproval).map((t) => t.name).sort()).toEqual(['createJob', 'createPlannedFeature', 'draftSpec']);
    });

    it('explains that coding agents use their routine\'s tools, and answers 404 for an unknown agent', async () => {
      const coding = await tools('coding');
      expect(coding).toMatchObject({ kind: 'routine', tools: [], projectTools: [] });
      expect(coding.note).toContain('routine');
      await http().get('/api/v1/agents/nobody/tools').set(bearer(token)).expect(404);
    });

    it('reports the Slack bot from bot users with an API key and the notification kinds', async () => {
      const before = (await http().get('/api/v1/agents/slack').set(bearer(token)).expect(200)).body;
      // The e2e database is shared with other files, so only this test's own bot is asserted below.
      expect(before).toMatchObject({ id: 'slack', label: 'Slack bot' });
      expect(before.notificationKinds).toContain('job.awaiting_review');
      const b = await bot('Slack Bot');
      const key = await createApiKey(app, b);
      await http().get('/api/v1/auth/me').set(bearer(key)).expect(200);
      const after = (await http().get('/api/v1/agents/slack').set(bearer(token)).expect(200)).body;
      expect(after.status).toBe('on');
      expect(after.botUsers.find((u: { email: string }) => u.email === b.email)).toMatchObject({ name: 'Slack Bot', lastUsedAt: expect.any(String) });
      expect(JSON.stringify(after)).not.toContain(key);
    });
  });

  describe('who may write', () => {
    const body = async () => {
      const a = await get('coding');
      return { enabled: true, botUserId: null, model: null, settings: a.settings };
    };

    it('refuses API keys, bot accounts and the scout account', async () => {
      const key = await createApiKey(app, human);
      await put('coding', await body(), key).expect(401);

      const b = await bot('Writer Bot');
      await put('coding', await body(), tokenFor(app, b)).expect(403);

      const scout = await createTestUser(app, { name: 'Scout' });
      const previous = process.env.SCOUT_USER_EMAIL;
      process.env.SCOUT_USER_EMAIL = scout.email;
      try {
        await put('coding', await body(), tokenFor(app, scout)).expect(403);
      } finally {
        if (previous === undefined) delete process.env.SCOUT_USER_EMAIL; else process.env.SCOUT_USER_EMAIL = previous;
      }
    });

    it('lets any authenticated user read, an API key included', async () => {
      const key = await createApiKey(app, human);
      await http().get('/api/v1/agents').set(bearer(key)).expect(200);
    });
  });

  describe('the coding agents', () => {
    it('keep their lesson settings and cannot be switched off in the settings', async () => {
      const current = await get('coding');
      const res = await put('coding', { enabled: false, botUserId: null, model: null, settings: current.settings }).expect(400);
      expect(res.body.issues[0].path).toBe('enabled');
      const ok = await put('coding', { enabled: true, botUserId: null, model: null, settings: { ...current.settings, lessonsTopK: 2 } }).expect(200);
      expect(ok.body.settings.lessonsTopK).toBe(2);
      expect(ok.body.status).toBe('on');
      expect((await app.get(AgentRuntimeService).settingsOf('coding')).lessonsTopK).toBe(2);
      await put('coding', { enabled: true, botUserId: null, model: null, settings: current.settings }).expect(200);
    });
  });
});

describe('AGENTS_DISABLED and MCP_ENABLED (e2e)', () => {
  let app: INestApplication;
  const previous = { disabled: process.env.AGENTS_DISABLED, mcp: process.env.MCP_ENABLED };

  afterEach(async () => {
    await app?.close();
    app = undefined as never;
    if (previous.disabled === undefined) delete process.env.AGENTS_DISABLED; else process.env.AGENTS_DISABLED = previous.disabled;
    if (previous.mcp === undefined) delete process.env.MCP_ENABLED; else process.env.MCP_ENABLED = previous.mcp;
  });

  async function start() {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    return { token: tokenFor(app, await createTestUser(app)) };
  }

  it('shows the named agents as disabled by the environment, whatever the database says', async () => {
    process.env.AGENTS_DISABLED = 'coding, werkmeester';
    const { token } = await start();
    const agents = (await request(app.getHttpServer()).get('/api/v1/agents').set({ Authorization: `Bearer ${token}` }).expect(200)).body as Agent[];
    expect(agents.filter((a) => a.status === 'disabled_by_env').map((a) => a.id).sort()).toEqual(expect.arrayContaining(['coding', 'werkmeester']));
    expect(agents.find((a) => a.id === 'coding')).toMatchObject({ status: 'disabled_by_env', reason: expect.stringContaining('AGENTS_DISABLED') });
    expect(agents.find((a) => a.id === 'gilde')!.status).not.toBe('disabled_by_env');
  });

  it('keeps the MCP server off without MCP_ENABLED=true, whatever its record says', async () => {
    delete process.env.MCP_ENABLED;
    const { token } = await start();
    const mcp = (await request(app.getHttpServer()).get('/api/v1/agents/mcp').set({ Authorization: `Bearer ${token}` }).expect(200)).body as Agent;
    expect(mcp.status).toBe('disabled_by_env');
    expect(mcp.reason).toContain('MCP_ENABLED');
  });

  it('refuses to start with an unknown id in AGENTS_DISABLED', async () => {
    process.env.AGENTS_DISABLED = 'verkenner,typo';
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile().then((m) => m.createNestApplication().init())).rejects.toThrow('typo');
  });
});
