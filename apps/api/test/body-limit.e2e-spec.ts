import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { authHeaders } from './helpers/auth.js';

const oneMb = JSON.stringify({ text: 'x'.repeat(1024 * 1024) });

describe('Request body limits (e2e)', () => {
  let app: INestApplication;
  let headers: { Authorization: string };

  beforeAll(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'limit-test-secret';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();
    headers = await authHeaders(app);
  });
  afterAll(() => app.close());

  const post = (path: string) => request(app.getHttpServer()).post(path).set(headers).set('Content-Type', 'application/json');

  it('accepts a 1 MB body on a co-pilot route', async () => {
    const res = await post('/api/v1/mastra/copilotkit').send(oneMb);
    expect(res.status).not.toBe(413);
  });

  it('rejects a 1 MB body on other routes with 413', async () => {
    await post('/api/v1/projects').send(oneMb).expect(413);
  });

  it('still rejects a co-pilot body above the limit', async () => {
    const huge = JSON.stringify({ text: 'x'.repeat(11 * 1024 * 1024) });
    await post('/api/v1/mastra/copilotkit').send(huge).expect(413);
  });

  it('keeps the raw body for the webhook signature', async () => {
    const body = JSON.stringify({ zen: 'keep it logically awesome' });
    const sig = `sha256=${createHmac('sha256', 'limit-test-secret').update(body).digest('hex')}`;
    const send = (signature: string) =>
      request(app.getHttpServer())
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', 'limit-test')
        .set('X-Hub-Signature-256', signature)
        .send(body);
    const ok = await send(sig).expect(200);
    expect(ok.body).toEqual({ result: 'pong' });
    await send('sha256=deadbeef').expect(401);
  });
});
