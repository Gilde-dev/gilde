import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { COPILOT_CONFIG } from './../src/copilot/copilot.tokens.js';
import { ScoutSuggestion } from './../src/copilot/scout-suggestion.entity.js';
import { ScoutSuggestionService, SUGGESTION_MARKER } from './../src/copilot/scout-suggestion.service.js';
import { ScoutWakeDay } from './../src/copilot/scout-wake-day.entity.js';
import { issueScoutBinding } from './../src/copilot/verkenner.context.js';
import { scoutConfig } from './../src/copilot/verkenner.config.js';
import { authedAgent, createTestUser } from './helpers/auth.js';

type Http = Awaited<ReturnType<typeof authedAgent>>;

async function seedProject(http: Http) {
  const slug = `sa-${randomUUID().slice(0, 8)}`;
  const project = (await http.post('/api/v1/projects').send({ slug, name: slug }).expect(201)).body as { id: string };
  const repo = (await http.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body as { id: string };
  const job = (await http.post(`/api/v1/repos/${repo.id}/jobs`).send({ title: 'Evidence job', task: 'Some earlier work item' }).expect(201)).body as { id: string };
  return { project, repo, job };
}

describe('Scout activity and suggestions (e2e), scout on', () => {
  let app: INestApplication;
  let http: Http;
  let bot: { id: string; name: string; email: string };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(COPILOT_CONFIG).useValue({ enabled: false, model: null, reason: 'x' })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
    bot = await createTestUser(app, { name: 'Verkenner' });
  });
  afterAll(() => app.close());

  /** A suggestion service for the real database, as if the scout were on with `bot` as its user. */
  const onService = () => {
    const base = app.get(ScoutSuggestionService) as unknown as Record<string, unknown>;
    const config = scoutConfig({ SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: bot.email, SCOUT_MODEL: 'openai/m', OPENAI_API_KEY: 'k' });
    if (!config.enabled) throw new Error('test setup');
    return new ScoutSuggestionService(
      app.get(DataSource), base.jobs as never, base.features as never, base.lessons as never, base.runs as never, base.repos as never,
      { user: bot, dailySuggestions: config.dailySuggestions },
    );
  };

  it('needs a token, a uuid project id and an existing project', async () => {
    await request(app.getHttpServer()).get(`/api/v1/copilot/scout-activity?projectId=${randomUUID()}`).expect(401);
    await http.get('/api/v1/copilot/scout-activity').expect(400);
    await http.get('/api/v1/copilot/scout-activity?projectId=nope').expect(400);
    await http.get(`/api/v1/copilot/scout-activity?projectId=${randomUUID()}`).expect(404);
  });

  it('creates a triage job by the scout user, shows it in the job list with its creator, and counts it for the week', async () => {
    const { project, repo, job } = await seedProject(http);
    const result = await onService().suggest(issueScoutBinding(bot.id, project.id), {
      repoId: repo.id, title: 'Follow up the evidence', task: 'Make the follow-up change the evidence points at.', acceptanceCriteria: ['It is done'],
      reason: 'The earlier job shows a gap.', basedOn: [job.id],
    });
    if (!result.created) throw new Error(JSON.stringify(result));

    const listed = (await http.get(`/api/v1/jobs?projectId=${project.id}`).expect(200)).body as { id: string; status: string; task: string; createdBy: { id: string; name: string } | null }[];
    const suggested = listed.find((j) => j.id === result.jobId)!;
    expect(suggested).toMatchObject({ status: 'triage', createdBy: { id: bot.id, name: 'Verkenner' } });
    expect(suggested.task).toContain(`## Why\nThe earlier job shows a gap.\n\nBased on: ${job.id}\n\n${SUGGESTION_MARKER}`);

    const activity = (await http.get(`/api/v1/copilot/scout-activity?projectId=${project.id}`).expect(200)).body;
    expect(activity).toMatchObject({ projectId: project.id, suggestionsThisWeek: 1, lastWakeAt: null });
    expect(JSON.stringify(activity)).not.toContain(bot.email);
    expect(Object.keys(activity).sort()).toEqual(['disabledReason', 'enabled', 'lastWakeAt', 'model', 'projectId', 'scoutUserId', 'suggestionsThisWeek', 'weekStart']);

    // Another project sees nothing of it.
    const other = await seedProject(http);
    expect((await http.get(`/api/v1/copilot/scout-activity?projectId=${other.project.id}`).expect(200)).body).toMatchObject({ suggestionsThisWeek: 0 });
  });

  it('reports the actual last wake of the project', async () => {
    const { project } = await seedProject(http);
    const wake = new Date('2026-01-05T06:00:00.000Z');
    await app.get(DataSource).getRepository(ScoutWakeDay).insert({ projectId: project.id, day: '2026-01-05', wakesUsed: 1, summaryClaimedAt: null, lastWakeAt: wake });
    expect((await http.get(`/api/v1/copilot/scout-activity?projectId=${project.id}`).expect(200)).body.lastWakeAt).toBe(wake.toISOString());
  });

  it('keeps the receipts after the suggested job is cancelled, and the week count still includes it', async () => {
    const { project, repo, job } = await seedProject(http);
    const result = await onService().suggest(issueScoutBinding(bot.id, project.id), {
      repoId: repo.id, title: 'Cancel me later', task: 'Make the follow-up change the evidence points at.', acceptanceCriteria: [], reason: 'Because of the job.', basedOn: [job.id],
    });
    if (!result.created) throw new Error('unreachable');
    await http.post(`/api/v1/jobs/${result.jobId}/cancel`).expect(200);
    expect(await app.get(DataSource).getRepository(ScoutSuggestion).countBy({ projectId: project.id })).toBe(1);
    expect((await http.get(`/api/v1/copilot/scout-activity?projectId=${project.id}`).expect(200)).body.suggestionsThisWeek).toBe(1);
  });
});

describe('Scout activity (e2e), scout configured but off', () => {
  let app: INestApplication;
  let http: Http;
  const previous = { ...process.env };

  beforeAll(async () => {
    delete process.env.SCOUT_ENABLED;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  });
  afterAll(async () => {
    await app.close();
    process.env = previous;
  });

  it('reports off with zero suggestions and never woken, and the status keeps its fields', async () => {
    const { project } = await seedProject(http);
    const activity = (await http.get(`/api/v1/copilot/scout-activity?projectId=${project.id}`).expect(200)).body;
    expect(activity).toMatchObject({ enabled: false, model: null, suggestionsThisWeek: 0, lastWakeAt: null });
    const status = (await http.get('/api/v1/copilot/status').expect(200)).body;
    expect(status).toMatchObject({ enabled: expect.any(Boolean), scout: { enabled: false, model: null, disabledReason: null } });
  });

  it('resolves the configured scout user id while off, so historical creator matches keep working', async () => {
    const { project } = await seedProject(http);
    const user = await createTestUser(app, { name: 'Verkenner', email: `scout-${randomUUID()}@example.com` });
    process.env.SCOUT_USER_EMAIL = user.email;
    try {
      const activity = (await http.get(`/api/v1/copilot/scout-activity?projectId=${project.id}`).expect(200)).body;
      expect(activity).toMatchObject({ enabled: false, scoutUserId: user.id });
      expect(JSON.stringify(activity)).not.toContain(user.email);
    } finally {
      delete process.env.SCOUT_USER_EMAIL;
    }
    expect((await http.get(`/api/v1/copilot/scout-activity?projectId=${project.id}`).expect(200)).body.scoutUserId).toBeNull();
  });

  it('refuses suggestions while off', async () => {
    const { project, repo, job } = await seedProject(http);
    const result = await app.get(ScoutSuggestionService).suggest(issueScoutBinding('x', project.id), {
      repoId: repo.id, title: 'Nope', task: 'Make the follow-up change.', acceptanceCriteria: [], reason: 'Because of the job.', basedOn: [job.id],
    });
    expect(result).toMatchObject({ created: false, refusal: { reason: 'scout_off' } });
  });
});
