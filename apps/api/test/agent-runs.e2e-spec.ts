// MCP is off unless enabled; the flag is read when AppModule is imported, hence the dynamic import below.
process.env.MCP_ENABLED = 'true';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';

import { createApiKey, createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { AgentRun } from './../src/agent-run/agent-run.entity.js';
import { AgentRunRecorder } from './../src/agent-run/agent-run.recorder.js';
import { AgentRunCleanupService } from './../src/agent-run/agent-run-cleanup.service.js';
import { AgentToolCall } from './../src/agent-run/agent-tool-call.entity.js';

const T0 = new Date('2026-09-01T10:00:00Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe('Agent run log (e2e)', () => {
  let app: INestApplication;
  let ann: TestUser;
  let bob: TestUser;
  let projectId: string;
  const http = () => request(app.getHttpServer());
  const jwt = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const runs = () => app.get<Repository<AgentRun>>(getRepositoryToken(AgentRun));
  const calls = () => app.get<Repository<AgentToolCall>>(getRepositoryToken(AgentToolCall));
  const run = (over: Partial<AgentRun>) => runs().save(runs().create({ agentId: 'werkmeester', triggerKind: 'spec_version', startedAt: at(0), endedAt: at(1), outcome: 'ok', ...over }));
  const call = (runId: string, over: Partial<AgentToolCall> = {}) => calls().save(calls().create({ runId, toolName: 'proposePlan', input: '{"a":1}', output: '{"ok":true}', durationMs: 7, ...over }));

  beforeAll(async () => {
    const { AppModule } = await import('./../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.listen(0);
    ann = await createTestUser(app, { name: 'Ann' });
    bob = await createTestUser(app, { name: 'Bob' });
    projectId = randomUUID();
  });
  afterAll(() => app.close());

  it('requires authentication', async () => {
    await http().get('/api/v1/agents/werkmeester/runs').expect(401);
    await http().get(`/api/v1/agent-runs/${randomUUID()}`).expect(401);
  });

  it('rejects an unknown agent, a bad id and invalid filters', async () => {
    await http().get('/api/v1/agents/nobody/runs').set(jwt(ann)).expect(404);
    await http().get('/api/v1/agent-runs/not-a-uuid').set(jwt(ann)).expect(400);
    await http().get(`/api/v1/agent-runs/${randomUUID()}`).set(jwt(ann)).expect(404);
    for (const q of ['trigger=nope', 'outcome=nope', 'projectId=nope', 'from=yesterday-ish', 'page=0', 'pageSize=101', 'pageSize=0']) {
      await http().get(`/api/v1/agents/werkmeester/runs?${q}`).set(jwt(ann)).expect(400);
    }
  });

  it('lists the runs of one agent with filters and pages', async () => {
    const p = randomUUID();
    const planned = await run({ projectId: p, startedAt: at(0), outcome: 'ok' });
    const failed = await run({ projectId: p, startedAt: at(60), outcome: 'error', reason: 'no valid plan' });
    await run({ projectId: p, startedAt: at(120), outcome: 'skipped', triggerKind: 'schedule' });
    await run({ agentId: 'verfijner', triggerKind: 'intake_item', projectId: p, startedAt: at(180) });
    await call(failed.id); await call(failed.id, { toolName: 'getSpec' });

    const all = await http().get(`/api/v1/agents/werkmeester/runs?projectId=${p}`).set(jwt(ann)).expect(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 25, total: 3 });
    expect(all.body.items.map((r: { outcome: string }) => r.outcome)).toEqual(['skipped', 'error', 'ok']); // newest first
    expect(all.body.items[1]).toMatchObject({ id: failed.id, agentId: 'werkmeester', reason: 'no valid plan', toolCallCount: 2, metadataOnly: false });

    const ids = async (q: string) => (await http().get(`/api/v1/agents/werkmeester/runs?projectId=${p}&${q}`).set(jwt(ann)).expect(200)).body.items.map((r: { id: string }) => r.id);
    expect(await ids('outcome=error')).toEqual([failed.id]);
    expect(await ids('trigger=schedule')).toHaveLength(1);
    expect(await ids(`from=${at(30).toISOString()}&to=${at(90).toISOString()}`)).toEqual([failed.id]);
    expect(await ids(`to=${at(60).toISOString()}`)).toEqual([planned.id]);

    const first = await http().get(`/api/v1/agents/werkmeester/runs?projectId=${p}&pageSize=2`).set(jwt(ann)).expect(200);
    const second = await http().get(`/api/v1/agents/werkmeester/runs?projectId=${p}&pageSize=2&page=2`).set(jwt(ann)).expect(200);
    expect(first.body).toMatchObject({ pageSize: 2, total: 3 });
    expect([...first.body.items, ...second.body.items].map((r: { id: string }) => r.id)).toEqual(all.body.items.map((r: { id: string }) => r.id));
    expect(second.body.items).toHaveLength(1);
  });

  it('returns a run with its tool calls in order', async () => {
    const r = await run({ agentId: 'verkenner', triggerKind: 'signal', projectId });
    await call(r.id, { toolName: 'listRepos', createdAt: at(1) });
    await call(r.id, { toolName: 'suggestJob', input: null, output: null, error: 'refused: daily limit', createdAt: at(2) });
    const res = await http().get(`/api/v1/agent-runs/${r.id}`).set(jwt(bob)).expect(200);
    expect(res.body).toMatchObject({ id: r.id, agentId: 'verkenner', toolCallCount: 2, metadataOnly: false });
    expect(res.body.toolCalls.map((c: { toolName: string }) => c.toolName)).toEqual(['listRepos', 'suggestJob']);
    expect(res.body.toolCalls[1]).toMatchObject({ error: 'refused: daily limit', input: null });
    expect(res.body.toolCalls[0]).toMatchObject({ input: '{"a":1}', output: '{"ok":true}', durationMs: 7 });
  });

  it("shows another user's co-pilot run as metadata only, and the caller's own in full", async () => {
    const theirs = await run({ agentId: 'gilde', triggerKind: 'chat', actorUserId: bob.id, triggerRefType: 'thread', triggerRefId: 'bobs-thread', reason: 'Bob wanted X', costUsd: 0.25, projectId });
    await call(theirs.id, { toolName: 'getJob', input: '{"jobId":"bobs-job"}', output: '{"task":"bobs private task"}' });
    await call(theirs.id, { toolName: 'listJobs' });

    const list = await http().get(`/api/v1/agents/gilde/runs?projectId=${projectId}`).set(jwt(ann)).expect(200);
    const item = list.body.items.find((r: { id: string }) => r.id === theirs.id);
    expect(item).toMatchObject({ metadataOnly: true, toolCallCount: 2, outcome: 'ok', costUsd: 0.25, reason: null, triggerRefId: null });
    const detail = await http().get(`/api/v1/agent-runs/${theirs.id}`).set(jwt(ann)).expect(200);
    expect(detail.body).toMatchObject({ metadataOnly: true, toolCallCount: 2, toolCalls: [] });
    expect(JSON.stringify([list.body, detail.body])).not.toMatch(/bobs-thread|bobs-job|bobs private task|Bob wanted X/);

    const own = await http().get(`/api/v1/agent-runs/${theirs.id}`).set(jwt(bob)).expect(200);
    expect(own.body).toMatchObject({ metadataOnly: false, triggerRefId: 'bobs-thread', reason: 'Bob wanted X' });
    expect(own.body.toolCalls).toHaveLength(2);
    expect(own.body.toolCalls[0].input).toBeDefined();
  });

  it('records an MCP tool call end to end, without the secret in its input', async () => {
    const key = await createApiKey(app, ann);
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const res = await http().post('/api/v1/mcp').set('Accept', 'application/json, text/event-stream').set('Authorization', `Bearer ${key}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'validateJob', arguments: { repoId: randomUUID(), title: 'A job', task: `Use ${secret} for it, please`, acceptanceCriteria: ['It works'] } } }).expect(200);
    expect(res.body.result).toBeDefined();
    await app.get(AgentRunRecorder).flush();

    const list = await http().get('/api/v1/agents/mcp/runs?trigger=mcp_call&pageSize=100').set(jwt(ann)).expect(200);
    const mine = list.body.items.find((r: { actorUserId: string; triggerRefId: string }) => r.actorUserId === ann.id && r.triggerRefId === 'validateJob');
    expect(mine).toMatchObject({ agentId: 'mcp', triggerKind: 'mcp_call', toolCallCount: 1 });
    expect(mine.endedAt).not.toBeNull();
    const detail = await http().get(`/api/v1/agent-runs/${mine.id}`).set(jwt(ann)).expect(200);
    expect(detail.body.toolCalls[0].toolName).toBe('validateJob');
    expect(JSON.stringify(detail.body)).not.toContain(secret);
    expect(detail.body.toolCalls[0].input).toContain('[redacted]');
  });

  it('removes runs past the retention window with their tool calls', async () => {
    const old = await run({ startedAt: new Date(Date.now() - 100 * 86_400_000), endedAt: new Date(Date.now() - 100 * 86_400_000) });
    await call(old.id);
    const recent = await run({ startedAt: new Date() });
    await app.get(AgentRunCleanupService).cleanup();
    await http().get(`/api/v1/agent-runs/${old.id}`).set(jwt(ann)).expect(404);
    expect(await calls().countBy({ runId: old.id })).toBe(0);
    await http().get(`/api/v1/agent-runs/${recent.id}`).set(jwt(ann)).expect(200);
  });
});
