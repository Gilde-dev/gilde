import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Repository } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { AgentRun } from './../src/agent-run/agent-run.entity.js';
import { AgentToolCall } from './../src/agent-run/agent-tool-call.entity.js';
import { COPILOT_INSTRUCTIONS } from './../src/copilot/copilot.instructions.js';
import { VERFIJNER_INSTRUCTIONS } from './../src/copilot/verfijner.instructions.js';
import { Notification } from './../src/notification/notification.entity.js';
import { NotificationService } from './../src/notification/notification.service.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

describe('Agent prompts and activity (e2e)', () => {
  let app: INestApplication;
  let ann: TestUser;
  const http = () => request(app.getHttpServer());
  const jwt = () => ({ Authorization: `Bearer ${tokenFor(app, ann)}` });

  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
  });
  afterAll(() => app.close());

  it('requires authentication and rejects unknown agents', async () => {
    await http().get('/api/v1/agents/gilde/prompt').expect(401);
    await http().get('/api/v1/agents/slack/notifications').expect(401);
    await http().get('/api/v1/agents/nobody/prompt').set(jwt()).expect(404);
    await http().get('/api/v1/agents/gilde/prompt?projectId=nope').set(jwt()).expect(400);
  });

  it('serves the instructions of the agents as the builders render them, with version and file link', async () => {
    const copilot = (await http().get('/api/v1/agents/gilde/prompt').set(jwt()).expect(200)).body;
    expect(copilot).toMatchObject({ agent: 'gilde', kind: 'instructions', note: null });
    expect(copilot.instructions.text.startsWith(COPILOT_INSTRUCTIONS)).toBe(true);
    expect(copilot.instructions.version).toMatch(/^[0-9a-f]{12}$/);
    expect(copilot.file.url).toContain('/blob/');
    expect(copilot.file.url).toContain('apps/api/src/copilot/copilot.instructions.ts');

    const refine = (await http().get('/api/v1/agents/verfijner/prompt').set(jwt()).expect(200)).body;
    expect(refine.instructions.text).toBe(VERFIJNER_INSTRUCTIONS);
    expect(refine.runPrompt.text).toContain('Refine GitHub issue #123');
    expect(refine.exampleBinding).toMatch(/Example binding/);
  });

  it('serves the coding agents\' variant and the agents without a prompt', async () => {
    const coding = (await http().get('/api/v1/agents/coding/prompt').set(jwt()).expect(200)).body;
    expect(coding.kind).toBe('instructions');
    expect(coding.coding.limit).toBe(60_000);
    expect(coding.coding.trimmingOrder.length).toBeGreaterThan(3);
    for (const id of ['mcp', 'slack']) {
      expect((await http().get(`/api/v1/agents/${id}/prompt`).set(jwt()).expect(200)).body).toMatchObject({ kind: 'none', instructions: null });
    }
  });

  it('is read-only: no route changes a prompt', async () => {
    for (const method of ['put', 'post', 'patch', 'delete'] as const) {
      const res = await http()[method]('/api/v1/agents/gilde/prompt').set(jwt()).send({ instructions: 'x' });
      expect([404, 405]).toContain(res.status);
    }
  });

  it('returns recorded content verbatim as JSON data, never as markup', async () => {
    const runs = app.get<Repository<AgentRun>>(getRepositoryToken(AgentRun));
    const calls = app.get<Repository<AgentToolCall>>(getRepositoryToken(AgentToolCall));
    const run = await runs.save(runs.create({ agentId: 'werkmeester', triggerKind: 'spec_version', startedAt: new Date(), endedAt: new Date(), outcome: 'error', reason: '<img src=x onerror=alert(1)>' }));
    await calls.save(calls.create({ runId: run.id, toolName: 'proposePlan', input: '<script>alert(1)</script>', output: null, error: '<b>boom</b>', durationMs: 3 }));
    const res = await http().get(`/api/v1/agent-runs/${run.id}`).set(jwt()).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.reason).toBe('<img src=x onerror=alert(1)>');
    expect(res.body.toolCalls[0]).toMatchObject({ input: '<script>alert(1)</script>', error: '<b>boom</b>' });
  });

  it('lists the notifications the Slack bot delivered', async () => {
    const slackKey = `e2e-slack-${Date.now()}`;
    const notifications = app.get(NotificationService);
    await notifications.recordQuietly({ occurrenceKey: slackKey, kind: 'job.parked', title: 'Parked <b>job</b>', repos: ['o/r'], reason: 'why' });
    // The e2e database is shared: look the row up by its key rather than in the first page of due rows.
    const row = await app.get<Repository<Notification>>(getRepositoryToken(Notification)).findOneByOrFail({ occurrenceKey: slackKey });
    await http().get('/api/v1/agents/slack/notifications').set(jwt()).expect(200).expect((r) => expect(r.body.items.some((i: { id: string }) => i.id === row.id)).toBe(false));
    await notifications.markDelivered(row.id);
    const res = await http().get('/api/v1/agents/slack/notifications?pageSize=5').set(jwt()).expect(200);
    expect(res.body.items.find((i: { id: string }) => i.id === row.id)).toMatchObject({ status: 'delivered', title: 'Parked <b>job</b>', kind: 'job.parked' });
    await http().get('/api/v1/agents/slack/notifications?pageSize=0').set(jwt()).expect(400);
  });

  it('rejects an invalid executor filter on the run log', async () => {
    await http().get('/api/v1/agents/coding/runs?executorId=nope').set(jwt()).expect(400);
    await http().get('/api/v1/agents/coding/runs?executorId=3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c').set(jwt()).expect(200);
  });
});
