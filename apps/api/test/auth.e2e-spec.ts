import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let user: TestUser;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    user = await createTestUser(app, { name: 'Ada', email: `Ada-${Date.now()}@Example.com` });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('login', () => {
    it('returns a token, expiry and the user for valid credentials', async () => {
      const res = await http().post('/api/v1/auth/login').send({ email: user.email, password: user.password }).expect(200);
      expect(res.body).toEqual({
        accessToken: expect.any(String),
        expiresIn: 12 * 60 * 60,
        user: { id: user.id, name: 'Ada', email: user.email },
      });
      expect(JSON.stringify(res.body)).not.toContain('$argon2');
      const payload = app.get(JwtService).decode(res.body.accessToken);
      expect(payload).toMatchObject({ sub: user.id, email: user.email, name: 'Ada' });
      expect(JSON.parse(Buffer.from(res.body.accessToken.split('.')[0], 'base64url').toString()).alg).toBe('HS256');
    });

    it('matches the email case-insensitively', async () => {
      await http().post('/api/v1/auth/login').send({ email: ` ${user.email.toUpperCase()} `, password: user.password }).expect(200);
    });

    it('gives the same 401 for an unknown email, a wrong password and missing fields', async () => {
      const wrongPassword = await http().post('/api/v1/auth/login').send({ email: user.email, password: 'nope-nope-nope' }).expect(401);
      const unknownEmail = await http().post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: user.password }).expect(401);
      const missing = await http().post('/api/v1/auth/login').send({}).expect(401);
      expect(wrongPassword.body.message).toBe('Invalid email or password');
      expect(unknownEmail.body).toEqual(wrongPassword.body);
      expect(missing.body).toEqual(wrongPassword.body);
    });

    it('stores an argon2id hash and never selects it by default', async () => {
      const ds = app.get(DataSource);
      const [row] = await ds.query('SELECT password FROM users WHERE id = ?', [user.id]);
      expect(row.password).toMatch(/^\$argon2id\$/);
      const loaded = await ds.getRepository('User').findOneBy({ id: user.id });
      expect((loaded as { password?: string }).password).toBeUndefined();
    });

    it('throttles to 5 attempts per minute', async () => {
      for (let i = 0; i < 5; i++) {
        await http().post('/api/v1/auth/login').send({ email: user.email, password: 'wrong-wrong-wrong' }).expect(401);
      }
      await http().post('/api/v1/auth/login').send({ email: user.email, password: user.password }).expect(429);
    });
  });

  describe('me', () => {
    it('returns the current user without the password', async () => {
      const res = await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenFor(app, user)}`).expect(200);
      expect(res.body).toEqual({ id: user.id, name: 'Ada', email: user.email, isAdmin: false });
    });

    it('is 401 for a token of a deleted user', async () => {
      const token = tokenFor(app, user);
      await app.get(DataSource).query('DELETE FROM users WHERE id = ?', [user.id]);
      await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
    });
  });

  describe('guard', () => {
    it.each(['/api/v1/auth/me', '/api/v1/projects', '/api/v1/jobs', '/api/v1/metrics'])('GET %s is 401 without a token', async (path) => {
      await http().get(path).expect(401);
    });

    it('is 401 for POST routes without a token', async () => {
      await http().post('/api/v1/projects').send({ slug: 'nope', name: 'Nope' }).expect(401);
      await http().post('/api/v1/dispatch').expect(401);
    });

    it('is 401 for an invalid, tampered, wrongly signed or expired token', async () => {
      const good = tokenFor(app, user);
      const [h, p, s] = good.split('.');
      const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'someone-else' })).toString('base64url');
      const wrongSecret = new JwtService({ secret: 'x'.repeat(40) }).sign({ sub: user.id, email: user.email, name: user.name }, { expiresIn: 60 });
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
      const expired = tokenFor(app, user, { expiresIn: -10 });
      for (const token of ['garbage', `${h}.${forgedPayload}.${s}`, wrongSecret, none, expired]) {
        await http().get('/api/v1/projects').set('Authorization', `Bearer ${token}`).expect(401);
      }
      await http().get('/api/v1/projects').set('Authorization', good).expect(401);
      await http().get('/api/v1/projects').set('Authorization', `Bearer ${good}`).expect(200);
    });

    it('keeps health and the webhook public (the webhook still checks its signature)', async () => {
      await http().get('/api/health').expect(200);
      const res = await http().post('/api/webhooks/github').send({}).expect(401);
      expect(res.body.message).toBe('Invalid signature');
    });

    it('does not throttle other routes', async () => {
      const token = tokenFor(app, user);
      for (let i = 0; i < 8; i++) {
        await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
      }
    });
  });
});
