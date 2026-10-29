import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { COPILOT_CONFIG, REFINE_SETUP, REFINE_WORKER } from './../src/copilot/copilot.tokens.js';
import { refineConfig } from './../src/copilot/verfijner.config.js';
import { scriptedModel, validSpecBody, type ScriptedStep } from './../src/copilot/verfijner.testing.js';
import type { VerfijnerWorker } from './../src/copilot/verfijner.worker.js';
import { GITHUB_PORT, GitHubRequestError, type GitHubPort } from './../src/github/github.port.js';
import { IntakeCommentService } from './../src/intake/intake-comment.service.js';
import { IntakeItem } from './../src/intake/intake-item.entity.js';
import { MEMORY_INFRASTRUCTURE } from './../src/memory/memory.tokens.js';
import { testMemoryInfrastructure } from './../src/memory/memory.testing.js';
import { UserService } from './../src/user/user.service.js';
import { authedAgent, createTestUser } from './helpers/auth.js';

const SECRET = 'intake-comments-webhook-secret';

describe('Intake status comment and answers (e2e), mocked GitHubPort and fake model', () => {
  let app: INestApplication;
  let dir: string;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let worker: VerfijnerWorker;
  let comments: IntakeCommentService;
  let clock: Date;
  let prompts: ReturnType<typeof scriptedModel>['prompts'];
  let projectId: string;
  let failWith: GitHubRequestError | null = null;
  const upserts: { fullName: string; number: number; marker: string; body: string; commentId: string | null }[] = [];

  const slug = `ic-${randomUUID().slice(0, 8)}`;
  const fullName = `o/${slug}`;
  const issueUrl = `https://github.com/${fullName}/issues/5`;
  const withQuestions = validSpecBody(issueUrl).replace('## Open questions\n\nNone\n', '## Open questions\n\n1. Which delimiter?\n2. Include a header row?\n');

  const steps: ScriptedStep[] = [
    { tool: 'saveRefinedSpec', input: { title: 'Export to CSV', body: withQuestions } },
    { text: 'Saved.' },
    { tool: 'saveRefinedSpec', input: { title: 'Export to CSV', body: validSpecBody(issueUrl) } },
    { text: 'Saved v2.' },
  ];

  const fakeGithub = {
    isConfigured: () => true,
    upsertIssueComment: async (repo: string, number: number, input: { marker: string; body: string; commentId: string | null }) => {
      if (failWith) throw failWith;
      upserts.push({ fullName: repo, number, ...input });
      return { id: '9001', htmlUrl: `https://github.com/${repo}/issues/${number}#issuecomment-9001` };
    },
    listOpenIssuesWithLabel: async () => ({ issues: [], complete: true }),
  } as unknown as GitHubPort;

  beforeAll(async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
    process.env.WEB_ORIGIN = 'http://web.test';
    dir = mkdtempSync(join(tmpdir(), 'gilde-e2e-intake-comments-'));
    const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
    await infra.storage.init();
    const stub = scriptedModel(steps);
    prompts = stub.prompts;
    const config = refineConfig({ REFINE_ENABLED: 'true', REFINE_USER_EMAIL: 'bot@example.com', REFINE_MODEL: 'openai/refine-model', OPENAI_API_KEY: 'k', REFINE_DAILY_LIMIT: '5' });
    if (!config.enabled) throw new Error('test setup');
    const setup = { config, user: { id: '', name: 'Verfijner', email: 'bot@example.com' }, model: stub.model };

    app = (await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(COPILOT_CONFIG).useValue({ enabled: true, model: 'openai/test-model' })
      .overrideProvider(MEMORY_INFRASTRUCTURE).useValue(infra)
      .overrideProvider(REFINE_SETUP).useValue(setup)
      .overrideProvider(GITHUB_PORT).useValue(fakeGithub)
      .compile()).createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();
    await app.get(DataSource).getRepository(IntakeItem).update({ status: 'new' }, { status: 'ignored' });

    const bot = await createTestUser(app, { name: 'Verfijner', email: `bot-${randomUUID()}@example.com` });
    await app.get(UserService).markBot(bot.email);
    setup.user.id = bot.id;
    http = await authedAgent(app);
    worker = app.get<VerfijnerWorker>(REFINE_WORKER);
    comments = app.get(IntakeCommentService);
    clock = new Date('2026-10-29T10:00:00Z');
    comments.now = () => clock;

    const project = (await http.post('/api/v1/projects').send({ slug, name: 'Comments' }).expect(201)).body;
    projectId = project.id;
    await http.post(`/api/v1/projects/${projectId}/repos`).send({ fullName }).expect(201);
  });
  afterAll(async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    delete process.env.WEB_ORIGIN;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  const deliver = (event: string, payload: object) => {
    const body = JSON.stringify({ repository: { full_name: fullName }, ...payload });
    return request(app.getHttpServer()).post('/api/webhooks/github').set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event).set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`).send(body);
  };
  const issue = { number: 5, node_id: 'I_kwDO5', html_url: issueUrl, title: 'Export to CSV', body: 'Users want a CSV export.', state: 'open', user: { login: 'octo' }, labels: [{ name: 'gilde:refine' }] };
  const answer = (id: number, association: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    deliver('issue_comment', {
      action: 'created', issue: { number: 5, html_url: issueUrl },
      comment: { id, body: '1. Use semicolons.\n2. Yes.', author_association: association, user: { login: 'maint', type: 'User' }, created_at: '2026-10-29T10:05:00Z', ...over },
      sender: { type: 'User' }, ...extra,
    });
  const item = async () => (await http.get(`/api/v1/projects/${projectId}/intake`).expect(200)).body[0] as Record<string, any>;
  const until = async (check: () => boolean) => { for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20)); };

  it('posts the draft, its questions and the link in one status comment after the refine', async () => {
    await deliver('issues', { action: 'labeled', issue }).expect(200);
    expect(await worker.tick()).toHaveLength(1);
    expect(upserts).toHaveLength(1);
    const [first] = upserts;
    const current = await item();
    expect(current).toMatchObject({ status: 'drafted', commentError: null, commentCount: 0 });
    expect(first).toMatchObject({ fullName, number: 5, commentId: null, marker: `<!-- gilde:intake:${current.id} -->` });
    expect(first.body).toContain(`http://web.test/specs/${current.specId}?project=${projectId}`);
    expect(first.body).toContain('**waiting for answers**');
    expect(first.body).toContain('1. Which delimiter?\n2. Include a header row?');
    expect(first.body).not.toContain('Users want a CSV export');
    expect(current.statusCommentUrl).toBe(`https://github.com/${fullName}/issues/5#issuecomment-9001`);
  });

  it('ignores untrusted commenters, bots and the app itself, and stores nothing', async () => {
    for (const res of [
      await answer(1, 'NONE').expect(200),
      await answer(2, 'CONTRIBUTOR').expect(200),
      await answer(3, 'MEMBER', { user: { login: 'gilde[bot]', type: 'Bot' } }, { sender: { type: 'Bot' } }).expect(200),
    ]) expect(res.text ?? res.body).toBeDefined();
    expect(await item()).toMatchObject({ status: 'drafted', commentCount: 0 });
    expect(await worker.tick()).toEqual([]);
    expect(upserts).toHaveLength(1);
  });

  it('takes a member answer, refines again with it as delimited data and updates the same comment', async () => {
    await answer(10, 'MEMBER').expect(200);
    expect(await item()).toMatchObject({ status: 'new', commentCount: 1 });
    await answer(10, 'MEMBER').expect(200); // re-delivery
    expect((await item()).commentCount).toBe(1);

    advance(2 * 60_000);
    expect(await worker.tick()).toHaveLength(1);
    const prompt = JSON.stringify(prompts[2]);
    expect(prompt).toContain('BEGIN ISSUE COMMENTS');
    expect(prompt).toContain('Use semicolons.');
    expect(upserts).toHaveLength(2);
    expect(upserts[1].commentId).toBe('9001');
    expect(upserts[1].body).toContain('version 2');
    expect(upserts[1].body).toContain('**ready to approve**');
    expect(upserts[1].body).not.toContain('Which delimiter?');
    expect(await item()).toMatchObject({ status: 'drafted' });
    // The unchanged answer does not refine again.
    expect(await worker.tick()).toEqual([]);
  });

  it('records commentError when GitHub refuses on approval, keeps the spec, and retries on the next outcome', async () => {
    const before = await item();
    failWith = new GitHubRequestError('GitHub PATCH failed: 403', 403);
    advance(2 * 60_000);
    await http.post(`/api/v1/specs/${before.specId}/approve`).send({ expectedVersion: 2 }).expect(200);
    await until(() => false || upserts.length > 2);
    let current = before;
    for (let i = 0; i < 50 && !current.commentError; i++) { await new Promise((r) => setTimeout(r, 20)); current = await item(); }
    expect(current.commentError).toContain('Issues: write');
    expect(current).toMatchObject({ status: 'drafted', specId: before.specId });
    expect((await http.get(`/api/v1/specs/${before.specId}`).expect(200)).body).toMatchObject({ status: 'approved', approvedVersion: 2 });

    failWith = null;
    advance(2 * 60_000);
    await comments.sync(before.id);
    expect(upserts).toHaveLength(3);
    expect(upserts[2].body).toContain('**approved**');
    expect(await item()).toMatchObject({ commentError: null });
  });
});
