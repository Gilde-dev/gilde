import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { randomUUID } from 'node:crypto';

import { authedAgent } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';
import { NotificationService } from './../src/notification/notification.service.js';

describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  let service: NotificationService;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    service = app.get(NotificationService);
  });

  afterEach(async () => {
    await app.close();
  });

  const record = async (kind: string, extra = {}) => {
    const key = `e2e-${randomUUID()}`;
    await service.recordQuietly({ occurrenceKey: key, kind: kind as 'job.parked', title: `T ${key}`, repos: ['o/r'], reason: 'why', ...extra });
    return key;
  };

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/notifications').expect(401);
    await request(app.getHttpServer()).post(`/api/v1/notifications/${randomUUID()}/delivered`).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/notifications/${randomUUID()}/failed`).send({ reason: 'x' }).expect(401);
  });

  it('validates kinds, limit, ids and failure bodies', async () => {
    const agent = await authedAgent(app);
    await agent.get('/api/v1/notifications?kinds=nope').expect(400);
    await agent.get('/api/v1/notifications?limit=0').expect(400);
    await agent.get('/api/v1/notifications?limit=1000').expect(400);
    await agent.post('/api/v1/notifications/not-a-uuid/delivered').expect(400);
    await agent.post(`/api/v1/notifications/${randomUUID()}/failed`).send({}).expect(400);
    await agent.post(`/api/v1/notifications/${randomUUID()}/failed`).send({ reason: 'x', retryAfterSeconds: 10 ** 9 }).expect(400);
    await agent.post(`/api/v1/notifications/${randomUUID()}/delivered`).expect(404);
    await agent.post(`/api/v1/notifications/${randomUUID()}/failed`).send({ reason: 'x' }).expect(404);
  });

  it('lists due rows by kind with a bounded batch and a recorded duplicate key', async () => {
    const agent = await authedAgent(app);
    const parked = await record('job.parked');
    await service.recordQuietly({ occurrenceKey: parked, kind: 'job.parked', title: 'dup', repos: [], reason: 'dup' });
    const revision = await record('revision.waiting');

    const list = (await agent.get('/api/v1/notifications?kinds=revision.waiting&limit=100').expect(200)).body;
    const keys = list.map((n: { occurrenceKey: string }) => n.occurrenceKey);
    expect(keys).toContain(revision);
    expect(keys).not.toContain(parked);

    const both = (await agent.get('/api/v1/notifications?kinds=job.parked,revision.waiting&limit=100').expect(200)).body;
    expect(both.filter((n: { occurrenceKey: string }) => n.occurrenceKey === parked)).toHaveLength(1);
    expect(both.find((n: { occurrenceKey: string }) => n.occurrenceKey === parked).title).not.toBe('dup');
    expect((await agent.get('/api/v1/notifications?limit=1').expect(200)).body).toHaveLength(1);
  });

  it('persists failures, excludes permanent and not-yet-due rows, and keeps delivery terminal', async () => {
    const agent = await authedAgent(app);
    const retry = await record('job.awaiting_review');
    const permanent = await record('job.awaiting_review');
    const done = await record('job.awaiting_review');
    const idOf = async (key: string) => (await agent.get('/api/v1/notifications?kinds=job.awaiting_review&limit=100')).body
      .find((n: { occurrenceKey: string }) => n.occurrenceKey === key).id as string;
    const [retryId, permanentId, doneId] = [await idOf(retry), await idOf(permanent), await idOf(done)];

    const failed = (await agent.post(`/api/v1/notifications/${retryId}/failed`).send({ reason: 'Slack 500', retryAfterSeconds: 3600 }).expect(200)).body;
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'Slack 500' });
    expect(new Date(failed.nextRetryAt).getTime()).toBeGreaterThan(Date.now());
    const perm = (await agent.post(`/api/v1/notifications/${permanentId}/failed`).send({ reason: 'channel_not_found', retryable: false }).expect(200)).body;
    expect(perm).toMatchObject({ status: 'failed', nextRetryAt: null });

    const delivered = (await agent.post(`/api/v1/notifications/${doneId}/delivered`).expect(200)).body;
    expect(delivered.status).toBe('delivered');
    expect((await agent.post(`/api/v1/notifications/${doneId}/delivered`).expect(200)).body.deliveredAt).toBe(delivered.deliveredAt);
    expect((await agent.post(`/api/v1/notifications/${doneId}/failed`).send({ reason: 'late' }).expect(200)).body).toMatchObject({ status: 'delivered', attempts: 0 });

    const keys = (await agent.get('/api/v1/notifications?kinds=job.awaiting_review&limit=100').expect(200)).body
      .map((n: { occurrenceKey: string }) => n.occurrenceKey);
    expect(keys).not.toContain(retry);
    expect(keys).not.toContain(permanent);
    expect(keys).not.toContain(done);
  });
});
