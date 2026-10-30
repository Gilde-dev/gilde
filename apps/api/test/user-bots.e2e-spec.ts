import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { UserService } from './../src/user/user.service.js';
import { createApiKey, createTestUser, tokenFor } from './helpers/auth.js';

describe('Create bot users (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });
  afterEach(() => app.close());

  it('requires authentication', async () => {
    await http().post('/api/v1/users/bots').send({ name: 'B', email: 'b@example.com' }).expect(401);
  });

  it('creates a bot that is listed with the bot users and returns no password', async () => {
    const human = await createTestUser(app);
    const email = `werkmeester-${randomUUID()}@example.com`;
    const res = await http().post('/api/v1/users/bots').set(bearer(tokenFor(app, human))).send({ name: 'Werkmeester', email }).expect(201);
    expect(res.body).toEqual({ id: expect.any(String), name: 'Werkmeester', email, isBot: true });
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);
    const bots = await http().get('/api/v1/agents/bot-users').set(bearer(tokenFor(app, human))).expect(200);
    expect((bots.body as { id: string }[]).map((b) => b.id)).toContain(res.body.id);
    expect(await app.get(UserService).findByEmail(email)).toBeTruthy();
  });

  it('refuses API keys and bots', async () => {
    const human = await createTestUser(app);
    const key = await createApiKey(app, human);
    await http().post('/api/v1/users/bots').set(bearer(key)).send({ name: 'B', email: `b-${randomUUID()}@example.com` }).expect(401);
    const bot = await createTestUser(app);
    await app.get(UserService).markBot(bot.email);
    await http().post('/api/v1/users/bots').set(bearer(tokenFor(app, bot))).send({ name: 'B', email: `b-${randomUUID()}@example.com` }).expect(403);
  });

  it('validates name and email', async () => {
    const human = await createTestUser(app);
    const res = await http().post('/api/v1/users/bots').set(bearer(tokenFor(app, human))).send({ name: '', email: 'nope' }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/name/);
    expect(JSON.stringify(res.body)).toMatch(/email/);
  });

  it('answers 409 with the mark-bot hint for an existing human', async () => {
    const human = await createTestUser(app);
    const other = await createTestUser(app);
    const res = await http().post('/api/v1/users/bots').set(bearer(tokenFor(app, human))).send({ name: 'X', email: other.email }).expect(409);
    expect(res.body.message).toContain(`user:mark-bot --email ${other.email}`);
  });
});
