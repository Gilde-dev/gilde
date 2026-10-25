import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

describe('API keys (e2e)', () => {
  let app: INestApplication<App>;
  let user: TestUser;
  let other: TestUser;
  const http = () => request(app.getHttpServer());
  const asUser = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const create = async (body: object = { name: 'bot' }, as: TestUser = user) =>
    (await http().post('/api/v1/api-keys').set(asUser(as)).send(body).expect(201)).body as {
      id: string; name: string; prefix: string; key: string; expiresAt: string | null;
    };
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    user = await createTestUser(app, { name: 'Bot' });
    other = await createTestUser(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a key that works as a Bearer token and acts as its owner', async () => {
    const created = await create({ name: 'bot', expiresInDays: 30 });
    expect(created).toEqual({
      id: expect.any(String),
      name: 'bot',
      prefix: expect.stringMatching(/^[0-9a-f]{8}$/),
      key: expect.stringMatching(/^gk_[0-9a-f]{8}_[0-9a-f]{64}$/),
      expiresAt: expect.any(String),
    });
    expect(created.key.startsWith(`gk_${created.prefix}_`)).toBe(true);
    const me = await http().get('/api/v1/auth/me').set(bearer(created.key)).expect(200);
    expect(me.body).toEqual({ id: user.id, name: 'Bot', email: user.email });
    await http().get('/api/v1/projects').set(bearer(created.key)).expect(200);
  });

  it('stores only the sha256 hash of the secret', async () => {
    const created = await create();
    const [row] = await app.get(DataSource).query('SELECT secret_hash FROM api_keys WHERE id = ?', [created.id]);
    const secret = created.key.split('_')[2];
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.secret_hash).not.toBe(secret);
    expect(created.key).not.toContain(row.secret_hash);
  });

  it('lists own keys without the secret or hash', async () => {
    const created = await create({ name: 'mine' });
    await create({ name: 'theirs' }, other);
    const res = await http().get('/api/v1/api-keys').set(asUser(user)).expect(200);
    expect(res.body).toEqual([{
      id: created.id, name: 'mine', prefix: created.prefix,
      createdAt: expect.any(String), lastUsedAt: null, expiresAt: null,
    }]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(created.key.split('_')[2]);
    expect(text).not.toContain('secret');
  });

  it('revokes an own key immediately and gives 404 for keys of others', async () => {
    const mine = await create();
    const theirs = await create({ name: 'theirs' }, other);
    await http().delete(`/api/v1/api-keys/${theirs.id}`).set(asUser(user)).expect(404);
    await http().get('/api/v1/auth/me').set(bearer(theirs.key)).expect(200);

    await http().get('/api/v1/auth/me').set(bearer(mine.key)).expect(200);
    await http().delete(`/api/v1/api-keys/${mine.id}`).set(asUser(user)).expect(204);
    await http().get('/api/v1/auth/me').set(bearer(mine.key)).expect(401);
    const list = await http().get('/api/v1/api-keys').set(asUser(user)).expect(200);
    expect(list.body).toEqual([]);
  });

  it('validates the create body', async () => {
    await http().post('/api/v1/api-keys').set(asUser(user)).send({}).expect(400);
    await http().post('/api/v1/api-keys').set(asUser(user)).send({ name: 'x', expiresInDays: 0 }).expect(400);
  });

  it('requires authentication to manage keys', async () => {
    await http().get('/api/v1/api-keys').expect(401);
    await http().post('/api/v1/api-keys').send({ name: 'x' }).expect(401);
  });

  describe('rejection', () => {
    it('gives the same 401 as an invalid JWT for expired, revoked, unknown, malformed and tampered keys', async () => {
      const invalidJwt = await http().get('/api/v1/auth/me').set(bearer('not-a-jwt')).expect(401);

      const expired = await create({ name: 'old', expiresInDays: 1 });
      await app.get(DataSource).query('UPDATE api_keys SET expires_at = ? WHERE id = ?', ['2000-01-01 00:00:00', expired.id]);
      const revoked = await create();
      await http().delete(`/api/v1/api-keys/${revoked.id}`).set(asUser(user)).expect(204);
      const valid = await create();
      const tampered = `${valid.key.slice(0, -1)}${valid.key.endsWith('0') ? '1' : '0'}`;
      const unknown = `gk_${'0'.repeat(8)}_${'a'.repeat(64)}`;

      for (const key of [expired.key, revoked.key, tampered, unknown, 'gk_', 'gk_short_secret', `${valid.key}x`]) {
        const res = await http().get('/api/v1/auth/me').set(bearer(key)).expect(401);
        expect(res.body).toEqual(invalidJwt.body);
      }
    });

    it('stops working when the user is deleted', async () => {
      const created = await create();
      await http().get('/api/v1/auth/me').set(bearer(created.key)).expect(200);
      const ds = app.get(DataSource);
      await ds.query('DELETE FROM users WHERE id = ?', [user.id]);
      await http().get('/api/v1/auth/me').set(bearer(created.key)).expect(401);
      const rows = await ds.query('SELECT id FROM api_keys WHERE id = ?', [created.id]);
      expect(rows).toEqual([]);
    });

    it('still handles other Bearer values as JWTs', async () => {
      await http().get('/api/v1/auth/me').set(asUser(user)).expect(200);
      await http().get('/api/v1/auth/me').set(bearer('gx_abc')).expect(401);
    });
  });

  it('updates last_used_at at most once per minute', async () => {
    const created = await create();
    const ds = app.get(DataSource);
    const lastUsed = async () => (await ds.query('SELECT last_used_at FROM api_keys WHERE id = ?', [created.id]))[0].last_used_at as string | null;
    expect(await lastUsed()).toBeNull();

    await http().get('/api/v1/auth/me').set(bearer(created.key)).expect(200);
    const first = await lastUsed();
    expect(first).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await http().get('/api/v1/auth/me').set(bearer(created.key)).expect(200);
    expect(await lastUsed()).toBe(first);

    await ds.query('UPDATE api_keys SET last_used_at = ? WHERE id = ?', ['2000-01-01 00:00:00', created.id]);
    await http().get('/api/v1/auth/me').set(bearer(created.key)).expect(200);
    expect(await lastUsed()).not.toBe('2000-01-01 00:00:00');
    const list = await http().get('/api/v1/api-keys').set(asUser(user)).expect(200);
    expect(list.body[0].lastUsedAt).not.toBeNull();
  });
});
