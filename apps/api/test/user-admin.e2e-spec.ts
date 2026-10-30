import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { seedFirstAdmin } from './../src/user/admin-seed.js';
import { hashSetupToken } from './../src/user/user-admin.service.js';
import { UserService } from './../src/user/user.service.js';
import { createApiKey, createTestUser, tokenFor, TEST_PASSWORD, type TestUser } from './helpers/auth.js';

describe('User management (e2e)', () => {
  let app: INestApplication;
  let admin: TestUser;
  const http = () => request(app.getHttpServer());
  const as = (u: Pick<TestUser, 'id' | 'email' | 'name'>) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const sql = <T = Record<string, unknown>>(q: string, params: unknown[] = []) => app.get(DataSource).query(q, params) as Promise<T[]>;
  const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

  beforeEach(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    admin = await createTestUser(app, { name: 'Admin' });
    await app.get(UserService).makeAdmin(admin.email);
  });

  afterEach(async () => {
    await app.close();
  });

  const invite = async (name = 'New Person') => {
    const email = `new-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await http().post('/api/v1/users').set(as(admin)).send({ name, email }).expect(201);
    return { email, ...res.body } as { email: string; user: { id: string; isAdmin: boolean }; setupLink: string; expiresAt: string };
  };
  const auditActions = async (target: string) => (await sql<{ action: string; actor_id: string }>('SELECT action, actor_id FROM user_audit_log WHERE target_user_id = ? ORDER BY created_at, rowid', [target]));

  describe('guards', () => {
    it('refuses every admin route to non-admins, API keys, bots and anonymous calls', async () => {
      const plain = await createTestUser(app);
      const bot = await createTestUser(app);
      await app.get(UserService).markBot(bot.email);
      const key = await createApiKey(app, admin);
      const id = plain.id;
      const routes: [string, string, object?][] = [
        ['get', '/api/v1/users'],
        ['post', '/api/v1/users', { name: 'X', email: 'x@example.com' }],
        ['post', `/api/v1/users/${id}/reset-link`],
        ['post', `/api/v1/users/${id}/deactivate`],
        ['post', `/api/v1/users/${id}/reactivate`],
        ['put', `/api/v1/users/${id}/admin`, { isAdmin: true }],
      ];
      for (const [method, url, body] of routes) {
        const send = (headers: Record<string, string>) => (http() as unknown as Record<string, (u: string) => request.Test>)[method](url).set(headers).send(body);
        await send({}).expect(401);
        await send(as(plain)).expect(403);
        await send(as(bot)).expect(403);
        await send({ Authorization: `Bearer ${key}` }).expect(401); // an admin's API key is not a JWT
      }
      expect((await sql('SELECT 1 FROM users WHERE email = ?', ['x@example.com']))).toHaveLength(0);
    });

    it('lists users without any password data', async () => {
      const res = await http().get('/api/v1/users').set(as(admin)).expect(200);
      expect(res.body.find((u: { id: string }) => u.id === admin.id)).toMatchObject({ name: 'Admin', email: admin.email, isBot: false, isAdmin: true, deactivatedAt: null, createdAt: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/);
    });

    it('shows isAdmin on /auth/me', async () => {
      const plain = await createTestUser(app);
      expect((await http().get('/api/v1/auth/me').set(as(admin)).expect(200)).body).toMatchObject({ id: admin.id, isAdmin: true });
      expect((await http().get('/api/v1/auth/me').set(as(plain)).expect(200)).body).toMatchObject({ id: plain.id, isAdmin: false });
    });
  });

  describe('setup links', () => {
    it('creates a user without a usable password, stores only the hash, and lets the link set a password once', async () => {
      const created = await invite();
      expect(created.user.isAdmin).toBe(false);
      expect(created.setupLink).toMatch(/\/setup\?token=[\w-]{43}$/);
      const token = tokenOf(created.setupLink);
      expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(23.9 * 3600_000);
      const rows = await sql<{ token_hash: string; purpose: string; used_at: unknown }>('SELECT token_hash, purpose, used_at FROM user_setup_tokens WHERE user_id = ?', [created.user.id]);
      expect(rows).toEqual([{ token_hash: hashSetupToken(token), purpose: 'setup', used_at: null }]);
      expect(JSON.stringify(rows)).not.toContain(token);

      // No password works before the link is used.
      await http().post('/api/v1/auth/login').send({ email: created.email, password: TEST_PASSWORD }).expect(401);

      const res = await http().post('/api/v1/auth/setup').send({ token, password: 'a-brand-new-password' }).expect(200);
      expect(res.body).toMatchObject({ accessToken: expect.any(String), user: { id: created.user.id, email: created.email } });
      await http().get('/api/v1/auth/me').set({ Authorization: `Bearer ${res.body.accessToken}` }).expect(200);
      await http().post('/api/v1/auth/login').send({ email: created.email, password: 'a-brand-new-password' }).expect(200);

      // Single use, with the same generic error as any other bad link.
      const again = await http().post('/api/v1/auth/setup').send({ token, password: 'another-new-password' }).expect(400);
      expect(again.body.message).toBe('This link is invalid or has expired');
      expect((await auditActions(created.user.id)).map((a) => a.action)).toEqual(['user_created', 'setup_completed']);
    });

    it('gives the same generic 400 for a wrong, expired and deactivated-user token', async () => {
      const created = await invite();
      const token = tokenOf(created.setupLink);
      const generic = { message: 'This link is invalid or has expired' };
      expect((await http().post('/api/v1/auth/setup').send({ token: 'x'.repeat(43), password: 'a-brand-new-password' }).expect(400)).body).toMatchObject(generic);

      await sql('UPDATE user_setup_tokens SET expires_at = ? WHERE user_id = ?', [new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace('Z', ''), created.user.id]);
      expect((await http().post('/api/v1/auth/setup').send({ token, password: 'a-brand-new-password' }).expect(400)).body).toMatchObject(generic);

      const second = await invite();
      await http().post(`/api/v1/users/${second.user.id}/deactivate`).set(as(admin)).expect(200);
      expect((await http().post('/api/v1/auth/setup').send({ token: tokenOf(second.setupLink), password: 'a-brand-new-password' }).expect(400)).body).toMatchObject(generic);
    });

    it('enforces the password rules and keeps the link usable after a rejected password', async () => {
      const created = await invite();
      const token = tokenOf(created.setupLink);
      await http().post('/api/v1/auth/setup').send({ token, password: 'short' }).expect(400);
      await http().post('/api/v1/auth/setup').send({ token, password: 'a-brand-new-password' }).expect(200);
    });

    it('throttles the setup endpoint to 5 per minute', async () => {
      for (let i = 0; i < 5; i++) await http().post('/api/v1/auth/setup').send({ token: `bad-${i}`, password: 'a-brand-new-password' }).expect(400);
      await http().post('/api/v1/auth/setup').send({ token: 'bad-6', password: 'a-brand-new-password' }).expect(429);
    });

    it('rejects an existing email', async () => {
      await http().post('/api/v1/users').set(as(admin)).send({ name: 'Dup', email: admin.email }).expect(409);
    });

    it('reset links replace earlier ones, change the password and keep working accounts', async () => {
      const created = await invite();
      const first = tokenOf(created.setupLink);
      const reset = (await http().post(`/api/v1/users/${created.user.id}/reset-link`).set(as(admin)).expect(201)).body;
      expect((await sql('SELECT purpose FROM user_setup_tokens WHERE user_id = ?', [created.user.id]))).toEqual([{ purpose: 'reset' }]);
      await http().post('/api/v1/auth/setup').send({ token: first, password: 'a-brand-new-password' }).expect(400);
      await http().post('/api/v1/auth/setup').send({ token: tokenOf(reset.setupLink), password: 'a-brand-new-password' }).expect(200);
      expect((await auditActions(created.user.id)).map((a) => a.action)).toEqual(['user_created', 'reset_link_created', 'setup_completed']);
      await http().post('/api/v1/users/00000000-0000-4000-8000-000000000000/reset-link').set(as(admin)).expect(404);
    });
  });

  describe('deactivation', () => {
    it('blocks login, JWTs and API keys at once, keeps history and can be undone', async () => {
      const person = await createTestUser(app);
      const key = await createApiKey(app, person);
      await http().get('/api/v1/auth/me').set(as(person)).expect(200); // warms the cache
      await http().get('/api/v1/auth/me').set({ Authorization: `Bearer ${key}` }).expect(200);

      const res = await http().post(`/api/v1/users/${person.id}/deactivate`).set(as(admin)).expect(200);
      expect(res.body.deactivatedAt).toEqual(expect.any(String));
      await http().get('/api/v1/auth/me').set(as(person)).expect(401);
      await http().get('/api/v1/auth/me').set({ Authorization: `Bearer ${key}` }).expect(401);
      await http().post('/api/v1/auth/login').send({ email: person.email, password: person.password }).expect(401);
      expect((await sql('SELECT 1 FROM users WHERE id = ?', [person.id]))).toHaveLength(1);

      await http().post(`/api/v1/users/${person.id}/reactivate`).set(as(admin)).expect(200);
      await http().get('/api/v1/auth/me').set(as(person)).expect(200);
      await http().get('/api/v1/auth/me').set({ Authorization: `Bearer ${key}` }).expect(200);
      expect(await auditActions(person.id)).toEqual([{ action: 'deactivated', actor_id: admin.id }, { action: 'reactivated', actor_id: admin.id }]);
    });

    it('expires the cached "active" state of another process within the cache window', async () => {
      const person = await createTestUser(app);
      await http().get('/api/v1/auth/me').set(as(person)).expect(200);
      await sql('UPDATE users SET deactivated_at = CURRENT_TIMESTAMP WHERE id = ?', [person.id]); // behind the service's back
      await http().get('/api/v1/auth/me').set(as(person)).expect(200); // still cached
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 31_000);
        await http().get('/api/v1/auth/me').set(as(person)).expect(401);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let an admin deactivate themselves or the last admin, nor remove the last admin', async () => {
      await sql('UPDATE users SET is_admin = false WHERE id <> ?', [admin.id]);
      await http().post(`/api/v1/users/${admin.id}/deactivate`).set(as(admin)).expect(409);
      await http().put(`/api/v1/users/${admin.id}/admin`).set(as(admin)).send({ isAdmin: false }).expect(409);

      const other = await createTestUser(app);
      await http().put(`/api/v1/users/${other.id}/admin`).set(as(admin)).send({ isAdmin: true }).expect(200);
      // Two admins: the other admin may deactivate the first, and then is the last one.
      await http().post(`/api/v1/users/${admin.id}/deactivate`).set(as(other)).expect(200);
      await http().post(`/api/v1/users/${other.id}/deactivate`).set(as(other)).expect(409);
      await http().put(`/api/v1/users/${other.id}/admin`).set(as(other)).send({ isAdmin: false }).expect(409);
      expect(await auditActions(other.id)).toEqual([{ action: 'admin_granted', actor_id: admin.id }]);
    });

    it('does not manage bots', async () => {
      const bot = await createTestUser(app);
      await app.get(UserService).markBot(bot.email);
      await http().post(`/api/v1/users/${bot.id}/deactivate`).set(as(admin)).expect(409);
      await http().post(`/api/v1/users/${bot.id}/reset-link`).set(as(admin)).expect(409);
      await http().put(`/api/v1/users/${bot.id}/admin`).set(as(admin)).send({ isAdmin: true }).expect(409);
    });
  });

  describe('admin role', () => {
    it('grants and revokes admin and audits both', async () => {
      const person = await createTestUser(app);
      expect((await http().put(`/api/v1/users/${person.id}/admin`).set(as(admin)).send({ isAdmin: true }).expect(200)).body.isAdmin).toBe(true);
      await http().get('/api/v1/users').set(as(person)).expect(200);
      await http().put(`/api/v1/users/${person.id}/admin`).set(as(admin)).send({ isAdmin: false }).expect(200);
      await http().get('/api/v1/users').set(as(person)).expect(403);
      expect((await auditActions(person.id)).map((a) => a.action)).toEqual(['admin_granted', 'admin_revoked']);
      await http().put(`/api/v1/users/${person.id}/admin`).set(as(admin)).send({ isAdmin: 'yes' }).expect(400);
    });

    it('makes a user an admin from the CLI service, idempotently', async () => {
      const person = await createTestUser(app);
      await app.get(UserService).makeAdmin(person.email.toUpperCase());
      await app.get(UserService).makeAdmin(person.email);
      expect((await http().get('/api/v1/auth/me').set(as(person))).body.isAdmin).toBe(true);
    });

    it('seeds the oldest human as admin only when there is no admin', async () => {
      const db = app.get(DataSource);
      const runner = db.createQueryRunner();
      try {
        expect(await seedFirstAdmin(runner)).toBeNull(); // an admin exists
        await sql('UPDATE users SET is_admin = false');
        const oldest = (await sql<{ email: string }>('SELECT email FROM users WHERE is_bot = false ORDER BY created_at ASC, id ASC LIMIT 1'))[0].email;
        expect(await seedFirstAdmin(runner)).toBe(oldest);
        expect(await sql('SELECT email FROM users WHERE is_admin = true')).toEqual([{ email: oldest }]);
        expect(await seedFirstAdmin(runner)).toBeNull();
      } finally {
        await runner.release();
      }
    });
  });
});
