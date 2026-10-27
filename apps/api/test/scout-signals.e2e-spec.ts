import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NotificationsStorage } from '@mastra/core/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { createMastra } from './../src/copilot/copilot.mastra.js';
import { COPILOT_CONFIG, COPILOT_MASTRA, SCOUT_GATE, SCOUT_SETUP } from './../src/copilot/copilot.tokens.js';
import { ScoutDispatchGate } from './../src/copilot/scout-delivery-policy.js';
import { ScoutSignalReceipt } from './../src/copilot/scout-signal-receipt.entity.js';
import { scoutConfig } from './../src/copilot/verkenner.config.js';
import { testMemoryInfrastructure } from './../src/memory/memory.testing.js';
import { authedAgent } from './helpers/auth.js';

async function newProject(http: Awaited<ReturnType<typeof authedAgent>>) {
  const slug = `scout-${Math.random().toString(36).slice(2, 8)}`;
  return (await http.post('/api/v1/projects').send({ slug, name: slug }).expect(201)).body as { id: string };
}

async function completeFeature(http: Awaited<ReturnType<typeof authedAgent>>, projectId: string) {
  const feature = (await http.post(`/api/v1/projects/${projectId}/features`).send({ title: 'A feature' }).expect(201)).body as { id: string };
  await http.post(`/api/v1/features/${feature.id}/start`).expect(200);
  await http.post(`/api/v1/features/${feature.id}/done`).expect(200);
  return feature.id;
}

describe('Scout signals (e2e), scout on', () => {
  let app: INestApplication;
  let dir: string;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let inbox: NotificationsStorage;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-scout-signals-'));
    const config = scoutConfig({ SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: 'bot@example.com', SCOUT_MODEL: 'openai/scout-model', OPENAI_API_KEY: 'k' });
    if (!config.enabled) throw new Error('test setup');
    const gate = new ScoutDispatchGate();
    const scout = { config, user: { id: 'bot-user', name: 'Verkenner', email: 'bot@example.com' }, gate };
    const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
    await infra.storage.init();
    inbox = (await infra.storage.getStore('notifications')) as NotificationsStorage;
    const mastra = createMastra({ enabled: false, model: null, reason: 'x' }, {} as never, undefined, undefined, infra, undefined, scout);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(COPILOT_CONFIG).useValue({ enabled: false, model: null, reason: 'x' })
      .overrideProvider(SCOUT_SETUP).useValue(scout)
      .overrideProvider(SCOUT_GATE).useValue(gate)
      .overrideProvider(COPILOT_MASTRA).useValue(mastra)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('closing a feature publishes one low feature-done signal, pending for the summary, with a receipt', async () => {
    const project = await newProject(http);
    const featureId = await completeFeature(http, project.id);

    const records = await inbox.listNotifications({ threadId: `verkenner:${project.id}`, source: 'gilde' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'feature-done', priority: 'low', status: 'pending', payload: { projectId: project.id, featureId, status: 'done' } });
    expect(records[0].summaryAt).toBeInstanceOf(Date);
    expect(records[0].summary.length).toBeLessThan(241);
    const receipts = await app.get(DataSource).getRepository(ScoutSignalReceipt).findBy({ projectId: project.id });
    expect(receipts.map((r) => r.dedupeKey)).toEqual([records[0].dedupeKey]);

    // Reopening and closing again is a new occurrence.
    await http.post(`/api/v1/features/${featureId}/reopen`).expect(200);
    await new Promise((r) => setTimeout(r, 5));
    await http.post(`/api/v1/features/${featureId}/done`).expect(200);
    expect(await inbox.listNotifications({ threadId: `verkenner:${project.id}`, source: 'gilde' })).toHaveLength(2);
  });

  it('does not break the domain call when the signal cannot be delivered', async () => {
    const project = await newProject(http);
    const ds = app.get(DataSource);
    const insert = vi.spyOn(ds.getRepository(ScoutSignalReceipt), 'insert').mockRejectedValue(new Error('db down'));
    try {
      await completeFeature(http, project.id); // the three feature calls still succeed
    } finally {
      insert.mockRestore();
    }
    expect(await inbox.listNotifications({ threadId: `verkenner:${project.id}`, source: 'gilde' })).toHaveLength(0);
  });
});

describe('Scout signals (e2e), scout off', () => {
  let app: INestApplication;
  let http: Awaited<ReturnType<typeof authedAgent>>;

  beforeAll(async () => {
    delete process.env.SCOUT_ENABLED;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  });
  afterAll(() => app.close());

  it('publishes nothing and records no receipt', async () => {
    const project = await newProject(http);
    await completeFeature(http, project.id);
    expect(await app.get(DataSource).getRepository(ScoutSignalReceipt).countBy({ projectId: project.id })).toBe(0);
  });
});
