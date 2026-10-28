import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { authedAgent } from './helpers/auth.js';

const APP_SECRET = 'app-webhook-secret';
const REPO_SECRET = 'repo-webhook-secret';

describe('GitHub App webhook (e2e)', () => {
  let app: INestApplication;
  let http: Awaited<ReturnType<typeof authedAgent>>;

  beforeAll(async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = APP_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = REPO_SECRET;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();
    http = await authedAgent(app);
  });
  afterAll(async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    await app.close();
  });

  const deliver = (event: string, payload: object, secret = APP_SECRET, delivery = randomUUID()) => {
    const body = JSON.stringify(payload);
    return request(app.getHttpServer())
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-GitHub-Delivery', delivery)
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
      .send(body);
  };

  it('verifies with either secret and rejects others', async () => {
    await deliver('ping', {}, APP_SECRET).expect(200);
    await deliver('ping', {}, REPO_SECRET).expect(200);
    await deliver('ping', {}, 'wrong').expect(401);
  });

  it('records installation events on the repo without registering or removing repos, and applies a delivery id once', async () => {
    const slug = `wh-${randomUUID().slice(0, 8)}`;
    const project = (await http.post('/api/v1/projects').send({ slug, name: 'WH' }).expect(201)).body;
    const repo = (await http.post(`/api/v1/projects/${project.id}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body;
    expect(repo).toMatchObject({ githubAppInstalled: null, githubAppWarning: null });

    const added = { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: `o/${slug}` }, { full_name: 'o/unregistered' }] };
    const delivery = randomUUID();
    await deliver('installation_repositories', added, APP_SECRET, delivery).expect(200);
    const again = await deliver('installation_repositories', added, REPO_SECRET, delivery).expect(200);
    expect(again.body.result).toContain('duplicate delivery');

    let repos = (await http.get(`/api/v1/projects/${project.id}/repos`).expect(200)).body;
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ githubAppInstalled: true, githubAppWarning: null });

    await deliver('installation_repositories', { action: 'removed', repositories_removed: [{ full_name: `o/${slug}` }] }).expect(200);
    repos = (await http.get(`/api/v1/projects/${project.id}/repos`).expect(200)).body;
    expect(repos).toHaveLength(1);
    expect(repos[0].githubAppInstalled).toBe(false);
  });
});
