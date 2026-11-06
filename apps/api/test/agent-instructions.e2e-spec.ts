import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';
import { ADDITION_PRECEDENCE } from './../src/agent-additions/agent-additions.render.js';
import { COPILOT_INSTRUCTIONS } from './../src/copilot/copilot.instructions.js';
import { UserService } from './../src/user/user.service.js';
import { createApiKey, createTestUser, tokenFor } from './helpers/auth.js';

describe('Per-project agent instructions (e2e)', () => {
  let app: INestApplication;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let plain: Awaited<ReturnType<typeof createTestUser>>;
  let projectId: string;
  const http = () => request(app.getHttpServer());
  const bearer = (u: { id: string; email: string; name: string }) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const base = () => `/api/v1/projects/${projectId}/agent-instructions`;

  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    admin = await createTestUser(app, { name: 'Admin' });
    await app.get(UserService).makeAdmin(admin.email);
    plain = await createTestUser(app, { name: 'Plain' });
    projectId = (await http().post('/api/v1/projects').set(bearer(admin)).send({ slug: `ai-${Date.now()}`, name: 'Acme Shop' }).expect(201)).body.id;
  });
  afterAll(() => app.close());

  it('requires authentication', async () => {
    await http().get(base()).expect(401);
    await http().put(`${base()}/gilde`).send({ text: 'x' }).expect(401);
    await http().get(`${base()}/gilde/history`).expect(401);
  });

  it('lets any user read all five agents, empty at first', async () => {
    const res = await http().get(base()).set(bearer(plain)).expect(200);
    expect(res.body.maxChars).toBe(4000);
    expect(res.body.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['gilde', 'verkenner', 'verfijner', 'werkmeester', 'reviewer']);
    expect(res.body.agents.every((a: { version: number; text: string }) => a.version === 0 && a.text === '')).toBe(true);
    await http().get('/api/v1/projects/not-a-uuid/agent-instructions').set(bearer(plain)).expect(400);
    await http().get('/api/v1/projects/3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c/agent-instructions').set(bearer(plain)).expect(404);
  });

  it('refuses writes by non-admins, API keys and bots', async () => {
    await http().put(`${base()}/gilde`).set(bearer(plain)).send({ text: 'x' }).expect(403);
    const adminKey = await createApiKey(app, admin);
    await http().put(`${base()}/gilde`).set({ Authorization: `Bearer ${adminKey}` }).send({ text: 'x' }).expect(401);
    const bot = await createTestUser(app, { name: 'Bot' });
    await app.get(UserService).markBot(bot.email);
    await http().put(`${base()}/gilde`).set(bearer(bot)).send({ text: 'x' }).expect(403);
    expect((await http().get(base()).set(bearer(admin)).expect(200)).body.agents.every((a: { version: number }) => a.version === 0)).toBe(true);
  });

  it('sets, changes and removes an addition with versions and history; coding agents and unknown agents are refused', async () => {
    const put = (agent: string, body: unknown) => http().put(`${base()}/${agent}`).set(bearer(admin)).send(body as object);
    expect((await put('gilde', { text: 'Terminology: a "gig" is a job.' }).expect(200)).body).toMatchObject({ agentId: 'gilde', version: 1, text: 'Terminology: a "gig" is a job.', updatedBy: { id: admin.id } });
    expect((await put('gilde', { text: 'Focus on checkout.' }).expect(200)).body.version).toBe(2);
    await put('gilde', { text: 'x'.repeat(4001) }).expect(400);
    await put('gilde', {}).expect(400);
    await put('gilde', { text: 'x', extra: 1 }).expect(400);
    await put('coding', { text: 'x' }).expect(400);
    await put('nobody', { text: 'x' }).expect(404);
    expect((await put('gilde', { text: '' }).expect(200)).body).toMatchObject({ version: 3, text: '' });

    const history = (await http().get(`${base()}/gilde/history`).set(bearer(plain)).expect(200)).body as Array<{ version: number; text: string; current: boolean }>;
    expect(history.map((h) => [h.version, h.text, h.current])).toEqual([[3, '', true], [2, 'Focus on checkout.', false], [1, 'Terminology: a "gig" is a job.', false]]);
    await http().get(`${base()}/coding/history`).set(bearer(plain)).expect(400);
  });

  it('shows the full prompt with the labelled addition for a selected project, and the base alone otherwise', async () => {
    await http().put(`${base()}/gilde`).set(bearer(admin)).send({ text: 'Focus on checkout.' }).expect(200);
    const withProject = (await http().get(`/api/v1/agents/gilde/prompt?projectId=${projectId}`).set(bearer(plain)).expect(200)).body;
    expect(withProject.instructions.text.startsWith(COPILOT_INSTRUCTIONS)).toBe(true);
    expect(withProject.instructions.text).toContain(`## Additional instructions for project Acme Shop\n${ADDITION_PRECEDENCE}\n\nFocus on checkout.`);
    expect(withProject.addition).toMatchObject({ projectId, projectName: 'Acme Shop', text: 'Focus on checkout.' });
    expect(withProject.instructions.text.endsWith(withProject.addition.block)).toBe(true);
    const plainPrompt = (await http().get('/api/v1/agents/gilde/prompt').set(bearer(plain)).expect(200)).body;
    expect(plainPrompt.addition).toBeNull();
    expect(plainPrompt.instructions.text).not.toContain('Additional instructions for project');
    expect(plainPrompt.instructions.version).not.toBe(withProject.instructions.version);
    const reviewer = (await http().get(`/api/v1/agents/reviewer/prompt?projectId=${projectId}`).set(bearer(plain)).expect(200)).body;
    expect(reviewer.kind).toBe('instructions');
    expect(reviewer.addition).toBeNull();
  });
});
