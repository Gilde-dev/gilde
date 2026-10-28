import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { ExecutorService } from './../src/executor/executor.service.js';
import { UserService } from './../src/user/user.service.js';
import { createApiKey, createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_01abc/fire';
const TOKEN = 'sk-ant-oat01-SUPERSECRETVALUE-7f3k';

describe('Executors (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let bob: TestUser;
  let repoId: string;
  const previousKey = process.env.EXECUTOR_SECRET_KEY;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const body = (over: object = {}) => ({ name: 'Mine', fireUrl: FIRE_URL, token: TOKEN, repoIds: [repoId], ...over });

  async function boot(key: string | undefined) {
    if (key === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = key;
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
    bob = await createTestUser(app, { name: 'Bob' });
    const slug = randomBytes(4).toString('hex');
    const project = (await http().post('/api/v1/projects').set(as(ann)).send({ name: `P ${slug}`, slug: `p-${slug}` })).body;
    repoId = (await http().post(`/api/v1/projects/${project.id}/repos`).set(as(ann)).send({ fullName: `o/${slug}` }).expect(201)).body.id;
  }

  afterEach(async () => {
    await app.close();
    if (previousKey === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = previousKey;
  });

  describe('with EXECUTOR_SECRET_KEY', () => {
    beforeEach(() => boot(randomBytes(32).toString('base64')));

    const create = async (as_: TestUser = ann, over: object = {}) =>
      (await http().post('/api/v1/executors').set(as(as_)).send(body(over)).expect(201)).body;

    it('creates, lists, reads, replaces and deletes your own executor', async () => {
      const created = await create();
      expect(created).toMatchObject({
        ownerId: ann.id, name: 'Mine', kind: 'routine', fireUrl: FIRE_URL, hasToken: true, tokenLast4: '7f3k',
        repoIds: [repoId], maxConcurrent: 1, dailyRunLimit: null, enabled: true, exhaustedUntil: null,
      });
      expect((await http().get('/api/v1/executors').set(as(ann)).expect(200)).body).toEqual([created]);
      expect((await http().get(`/api/v1/executors/${created.id}`).set(as(ann)).expect(200)).body).toEqual(created);

      const replaced = await http().put(`/api/v1/executors/${created.id}`).set(as(ann))
        .send({ name: 'Renamed', fireUrl: FIRE_URL, repoIds: [], maxConcurrent: 3, dailyRunLimit: 20, enabled: false }).expect(200);
      expect(replaced.body).toMatchObject({ name: 'Renamed', repoIds: [], maxConcurrent: 3, dailyRunLimit: 20, enabled: false, tokenLast4: '7f3k' });

      await http().delete(`/api/v1/executors/${created.id}`).set(as(ann)).expect(204);
      await http().get(`/api/v1/executors/${created.id}`).set(as(ann)).expect(404);
    });

    it('never returns the token or its ciphertext, and stores it encrypted', async () => {
      const created = await create();
      const responses = [
        JSON.stringify(created),
        JSON.stringify((await http().get('/api/v1/executors').set(as(ann))).body),
        JSON.stringify((await http().get(`/api/v1/executors/${created.id}`).set(as(ann))).body),
        JSON.stringify((await http().put(`/api/v1/executors/${created.id}`).set(as(ann))
          .send({ name: 'x', fireUrl: FIRE_URL, repoIds: [], maxConcurrent: 1, dailyRunLimit: null, enabled: true })).body),
      ];
      const invalid = await http().post('/api/v1/executors').set(as(ann)).send(body({ name: 'Other', fireUrl: 'http://x.test' }));
      responses.push(JSON.stringify(invalid.body));
      const badToken = await http().put(`/api/v1/executors/${created.id}/token`).set(as(ann)).send({ token: 'has space' });
      expect(badToken.status).toBe(400);
      responses.push(JSON.stringify(badToken.body));
      for (const r of responses) {
        expect(r).not.toContain('SUPERSECRET');
        expect(r).not.toMatch(/ciphertext|tokenIv|tokenTag|token_iv|keyVersion/i);
      }
      const row = (await app.get(DataSource).query('SELECT * FROM executors WHERE id = ?', [created.id]))[0];
      expect(JSON.stringify(row)).not.toContain('SUPERSECRET');
      expect(row.token_ciphertext).toEqual(expect.any(String));
      expect(row.key_version).toBe(1);
      expect(await app.get(ExecutorService).revealToken(created.id)).toBe(TOKEN);
    });

    it('replaces only the token, with a new IV', async () => {
      const created = await create();
      const before = (await app.get(DataSource).query('SELECT token_iv FROM executors WHERE id = ?', [created.id]))[0].token_iv;
      await http().put(`/api/v1/executors/${created.id}/token`).set(as(ann)).send({ token: 'new-token-abcd' }).expect(204);
      const after = (await app.get(DataSource).query('SELECT token_iv FROM executors WHERE id = ?', [created.id]))[0].token_iv;
      expect(after).not.toBe(before);
      expect((await http().get(`/api/v1/executors/${created.id}`).set(as(ann))).body).toMatchObject({ tokenLast4: 'abcd', name: 'Mine' });
      expect(await app.get(ExecutorService).revealToken(created.id)).toBe('new-token-abcd');
    });

    it('is personal: lists only your own and answers 404 for another user on every route', async () => {
      const mine = await create();
      expect((await http().get('/api/v1/executors').set(as(bob)).expect(200)).body).toEqual([]);
      await http().get(`/api/v1/executors/${mine.id}`).set(as(bob)).expect(404);
      await http().put(`/api/v1/executors/${mine.id}`).set(as(bob))
        .send({ name: 'x', fireUrl: FIRE_URL, repoIds: [], maxConcurrent: 1, dailyRunLimit: null, enabled: true }).expect(404);
      await http().put(`/api/v1/executors/${mine.id}/token`).set(as(bob)).send({ token: 'stolen-token' }).expect(404);
      await http().delete(`/api/v1/executors/${mine.id}`).set(as(bob)).expect(404);
      expect((await http().get(`/api/v1/executors/${mine.id}`).set(as(ann)).expect(200)).body.name).toBe('Mine');
      expect(await app.get(ExecutorService).revealToken(mine.id)).toBe(TOKEN);
    });

    it('refuses writes by API key and by bot, while an API key may still read', async () => {
      const mine = await create();
      const key = await createApiKey(app, ann);
      const viaKey = { Authorization: `Bearer ${key}` };
      await http().post('/api/v1/executors').set(viaKey).send(body({ name: 'Key' })).expect(401);
      await http().put(`/api/v1/executors/${mine.id}`).set(viaKey)
        .send({ name: 'x', fireUrl: FIRE_URL, repoIds: [], maxConcurrent: 1, dailyRunLimit: null, enabled: true }).expect(401);
      await http().put(`/api/v1/executors/${mine.id}/token`).set(viaKey).send({ token: 'new-token' }).expect(401);
      await http().delete(`/api/v1/executors/${mine.id}`).set(viaKey).expect(401);
      await http().get('/api/v1/executors').set(viaKey).expect(200);

      const bot = await createTestUser(app, { name: 'Bot' });
      await app.get(UserService).markBot(bot.email);
      await http().post('/api/v1/executors').set(as(bot)).send(body({ name: 'Bot' })).expect(403);
      await http().delete(`/api/v1/executors/${mine.id}`).set(as(bot)).expect(403);
      expect((await http().get('/api/v1/executors').set(as(ann))).body).toHaveLength(1);
      await http().post('/api/v1/executors').send(body()).expect(401);
    });

    it('validates the URL, repos, name uniqueness per owner and limits', async () => {
      await create();
      await http().post('/api/v1/executors').set(as(ann)).send(body({ name: 'Mine' })).expect(409);
      await create(bob); // same name, another owner
      await http().post('/api/v1/executors').set(as(ann)).send(body({ name: 'A', fireUrl: 'https://example.com/fire' })).expect(400);
      await http().post('/api/v1/executors').set(as(ann)).send(body({ name: 'A', maxConcurrent: 11 })).expect(400);
      await http().post('/api/v1/executors').set(as(ann)).send(body({ name: 'A', dailyRunLimit: 0 })).expect(400);
      await http().post('/api/v1/executors').set(as(ann)).send(body({ name: 'A', repoIds: ['3f2b1c9e-5a4d-4e6f-8a7b-1c2d3e4f5a6b'] })).expect(404);
      const second = await create(ann, { name: 'Second', repoIds: [repoId, repoId], dailyRunLimit: 5, maxConcurrent: 2, enabled: false });
      expect(second).toMatchObject({ repoIds: [repoId], dailyRunLimit: 5, maxConcurrent: 2, enabled: false });
      const put = (over: object) => http().put(`/api/v1/executors/${second.id}`).set(as(ann))
        .send({ name: 'Second', fireUrl: FIRE_URL, repoIds: [repoId], maxConcurrent: 1, dailyRunLimit: null, enabled: true, ...over });
      await put({ name: 'Mine' }).expect(409);
      await put({ repoIds: ['3f2b1c9e-5a4d-4e6f-8a7b-1c2d3e4f5a6b'] }).expect(404);
      await put({ maxConcurrent: 0 }).expect(400);
      await put({ name: 'Second' }).expect(200);
    });
  });

  describe('without EXECUTOR_SECRET_KEY', () => {
    beforeEach(() => boot(undefined));

    it('starts and lists, but creating and setting a token answer 503', async () => {
      expect((await http().get('/api/v1/executors').set(as(ann)).expect(200)).body).toEqual([]);
      const res = await http().post('/api/v1/executors').set(as(ann)).send(body()).expect(503);
      expect(JSON.stringify(res.body)).toContain('EXECUTOR_SECRET_KEY');
      expect(JSON.stringify(res.body)).not.toContain('SUPERSECRET');
      // an executor without a token cannot exist via the API, so insert one directly to reach the token route
      const id = randomUUID();
      await app.get(DataSource).query(
        'INSERT INTO executors (id, owner_id, name, kind, fire_url, repo_ids, key_version, max_concurrent, enabled) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)',
        [id, ann.id, 'Bare', 'routine', FIRE_URL, '[]'],
      );
      expect((await http().get(`/api/v1/executors/${id}`).set(as(ann)).expect(200)).body).toMatchObject({ hasToken: false, tokenLast4: null });
      await http().put(`/api/v1/executors/${id}/token`).set(as(ann)).send({ token: 'new-token-abcd' }).expect(503);
    });
  });

  it('fails startup closed on a malformed EXECUTOR_SECRET_KEY', async () => {
    process.env.EXECUTOR_SECRET_KEY = 'definitely-not-a-valid-key';
    try {
      await expect(Test.createTestingModule({ imports: [AppModule] }).compile().then((m) => m.createNestApplication().init()))
        .rejects.toThrow(/EXECUTOR_SECRET_KEY must be base64/);
    } finally {
      if (previousKey === undefined) delete process.env.EXECUTOR_SECRET_KEY;
      else process.env.EXECUTOR_SECRET_KEY = previousKey;
    }
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
  });
});
