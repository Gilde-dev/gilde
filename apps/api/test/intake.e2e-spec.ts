import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { GITHUB_PORT } from './../src/github/github.port.js';
import { authedAgent, createApiKey, createTestUser } from './helpers/auth.js';

const SECRET = 'intake-webhook-secret';

describe('Issue intake (e2e)', () => {
  let app: INestApplication;
  let http: Awaited<ReturnType<typeof authedAgent>>;

  beforeAll(async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
    // The sweep lists issues of every repo in the shared database; the real adapter would call GitHub (slow, and a timeout) when a token is set.
    const github = { isConfigured: () => false };
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(GITHUB_PORT).useValue(github).compile())
      .createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();
    http = await authedAgent(app);
  });
  afterAll(async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    await app.close();
  });

  const deliver = (payload: object) => {
    const body = JSON.stringify(payload);
    return request(app.getHttpServer())
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues')
      .set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`)
      .send(body);
  };
  const issuePayload = (fullName: string, action: string, over: Record<string, unknown> = {}) => ({
    action,
    repository: { full_name: fullName },
    issue: {
      number: 5, node_id: 'I_kwDO5', html_url: `https://github.com/${fullName}/issues/5`, title: 'Export to CSV',
      body: 'Users want a CSV export.', state: 'open', user: { login: 'octo' }, labels: [{ name: 'gilde:refine' }], ...over,
    },
  });

  it('turns a labelled issue into an intake item, lists it and follows the label', async () => {
    const slug = `in-${randomUUID().slice(0, 8)}`;
    const project = (await http.post('/api/v1/projects').send({ slug, name: 'Intake' }).expect(201)).body;
    await http.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201);

    await deliver(issuePayload(`o/${slug}`, 'opened', { labels: [{ name: 'bug' }] })).expect(200);
    await deliver(issuePayload('o/unregistered', 'opened')).expect(200);
    await deliver(issuePayload(`o/${slug}`, 'opened', { pull_request: {} })).expect(200);
    expect((await http.get(`/api/v1/projects/${project.id}/intake`).expect(200)).body).toEqual([]);

    await deliver(issuePayload(`o/${slug}`, 'labeled')).expect(200);
    const list = (await http.get(`/api/v1/projects/${project.id}/intake`).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      repoFullName: `o/${slug}`, number: 5, title: 'Export to CSV', status: 'new', source: 'github_issue',
      url: `https://github.com/o/${slug}/issues/5`, labels: ['gilde:refine'], specId: null,
    });
    expect(list[0]).not.toHaveProperty('body');

    const detail = (await http.get(`/api/v1/intake/${list[0].id}`).expect(200)).body;
    expect(detail).toMatchObject({ body: 'Users want a CSV export.', bodyTruncated: false });
    expect(detail.bodySha256).toMatch(/^[0-9a-f]{64}$/);

    await deliver(issuePayload(`o/${slug}`, 'unlabeled', { labels: [] })).expect(200);
    expect((await http.get(`/api/v1/projects/${project.id}/intake?status=withdrawn`).expect(200)).body).toHaveLength(1);
    expect((await http.get(`/api/v1/projects/${project.id}/intake?status=new`).expect(200)).body).toHaveLength(0);
    await http.get(`/api/v1/projects/${project.id}/intake?status=bogus`).expect(400);
  });

  it('lets a verified human ignore and retry, refuses API keys (the human guard) and anonymous callers', async () => {
    const slug = `in-${randomUUID().slice(0, 8)}`;
    const project = (await http.post('/api/v1/projects').send({ slug, name: 'Intake' }).expect(201)).body;
    await http.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201);
    await deliver(issuePayload(`o/${slug}`, 'opened')).expect(200);
    const id = (await http.get(`/api/v1/projects/${project.id}/intake`).expect(200)).body[0].id as string;

    const user = await createTestUser(app);
    const key = await createApiKey(app, user);
    await request(app.getHttpServer()).post(`/api/v1/intake/${id}/ignore`).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/intake/${id}/ignore`).set('Authorization', `Bearer ${key}`).expect(401);
    await request(app.getHttpServer()).post('/api/v1/intake/sweep').set('Authorization', `Bearer ${key}`).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/intake/${id}`).set('Authorization', `Bearer ${key}`).expect(200);

    expect((await http.post(`/api/v1/intake/${id}/ignore`).expect(200)).body.status).toBe('ignored');
    await deliver(issuePayload(`o/${slug}`, 'edited', { body: 'edited text' })).expect(200);
    expect((await http.get(`/api/v1/intake/${id}`).expect(200)).body).toMatchObject({ status: 'ignored', body: 'edited text' });
    expect((await http.post(`/api/v1/intake/${id}/retry`).expect(200)).body).toMatchObject({ status: 'new', lastError: null });
    await http.post(`/api/v1/intake/${id}/retry`).expect(409);
    await http.post(`/api/v1/intake/${randomUUID()}/retry`).expect(404);
    expect((await http.post('/api/v1/intake/sweep').expect(200)).body).toMatchObject({ repos: 0 });
  });
});
