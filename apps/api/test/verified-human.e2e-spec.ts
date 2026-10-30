import { Test } from '@nestjs/testing';
import { Controller, Get, Module, Req, UseGuards, type INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { ApiKeyService } from './../src/api-key/api-key.service.js';
import type { AuthUser } from './../src/auth/auth.dto.js';
import { JwtHumanGuard } from './../src/auth/jwt-human.guard.js';
import type { UserIdentityDto } from './../src/user/user.dto.js';
import { UserModule } from './../src/user/user.module.js';
import { UserService } from './../src/user/user.service.js';
import { createTestUser, tokenFor } from './helpers/auth.js';

@Controller('/v1/test-human')
class HumanOnlyController {
  constructor(private readonly users: UserService) { }

  @Get()
  @UseGuards(JwtHumanGuard)
  async only(@Req() req: Request & { user?: AuthUser }): Promise<UserIdentityDto> {
    return this.users.requireVerifiedHuman(req.user);
  }

  @Get('plain')
  plain(@Req() req: Request & { user?: AuthUser }) {
    return { credential: req.user?.credential ?? null };
  }
}

@Module({ imports: [UserModule, PassportModule.register({})], controllers: [HumanOnlyController] })
class HumanOnlyModule { }

describe('Verified human (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const previousScout = process.env.SCOUT_USER_EMAIL;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule, HumanOnlyModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    if (previousScout === undefined) delete process.env.SCOUT_USER_EMAIL;
    else process.env.SCOUT_USER_EMAIL = previousScout;
  });

  it('accepts a persisted JWT human', async () => {
    const user = await createTestUser(app);
    const res = await http().get('/api/v1/test-human').set(bearer(tokenFor(app, user))).expect(200);
    expect(res.body).toEqual({ id: user.id, email: user.email, isBot: false, isAdmin: false, deactivated: false });
  });

  it('rejects an API key, even of a human account', async () => {
    const user = await createTestUser(app);
    const { key } = await app.get(ApiKeyService).create(user.id, { name: 'k' });
    await http().get('/api/v1/test-human').set(bearer(key)).expect(401);
    const plain = await http().get('/api/v1/test-human/plain').set(bearer(key)).expect(200);
    expect(plain.body).toEqual({ credential: 'api_key' });
  });

  it('marks JWT provenance only after authentication and ignores spoofed claims, headers and bodies', async () => {
    const user = await createTestUser(app);
    const plain = await http().get('/api/v1/test-human/plain').set(bearer(tokenFor(app, user))).set('X-Credential', 'api_key').expect(200);
    expect(plain.body).toEqual({ credential: 'jwt' });
    await http().get('/api/v1/test-human/plain').expect(401);
    await http().get('/api/v1/test-human/plain').set(bearer(`${tokenFor(app, user)}x`)).expect(401);
    await http().get('/api/v1/test-human').query({ credential: 'jwt' }).send({ credential: 'jwt', user: { credential: 'jwt' } }).expect(401);
  });

  it('rejects a stale token after the account is marked a bot', async () => {
    const user = await createTestUser(app);
    const token = tokenFor(app, user);
    await http().get('/api/v1/test-human').set(bearer(token)).expect(200);
    await app.get(UserService).markBot(user.email);
    await http().get('/api/v1/test-human').set(bearer(token)).expect(403);
  });

  it('rejects a deleted user with a still-valid token', async () => {
    const user = await createTestUser(app);
    await app.get(DataSource).query('DELETE FROM users WHERE id = ?', [user.id]);
    await http().get('/api/v1/test-human').set(bearer(tokenFor(app, user))).expect(403);
  });

  it('rejects the configured scout account even when unmarked', async () => {
    const user = await createTestUser(app);
    process.env.SCOUT_USER_EMAIL = user.email.toUpperCase();
    await http().get('/api/v1/test-human').set(bearer(tokenFor(app, user))).expect(403);
  });

  it('rejects a bot created with --bot semantics', async () => {
    const bot = await app.get(UserService).create({ name: 'Bot', email: `bot-${Date.now()}@example.com`, password: 'correct-horse-battery' }, { isBot: true });
    await http().get('/api/v1/test-human').set(bearer(tokenFor(app, bot))).expect(403);
  });
});

describe('Bot accounts (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('defaults is_bot to false, marks idempotently and keeps the password hash', async () => {
    const users = app.get(UserService);
    const ds = app.get(DataSource);
    const user = await createTestUser(app, { email: `Mixed-${Date.now()}@Example.com` });
    const hash = async () => (await ds.query('SELECT password, is_bot FROM users WHERE id = ?', [user.id]))[0];
    const before = await hash();
    expect(Boolean(before.is_bot)).toBe(false);

    await users.markBot(` ${user.email.toUpperCase()} `);
    await users.markBot(user.email);
    const after = await hash();
    expect(Boolean(after.is_bot)).toBe(true);
    expect(after.password).toBe(before.password);
    expect(await users.findIdentity(user.id)).toMatchObject({ isBot: true });
  });

  it('reports a clear error for a missing account', async () => {
    await expect(app.get(UserService).markBot('Nobody@Example.com')).rejects.toThrow('No user with email nobody@example.com');
  });

  it('keeps login, auth/me and old routes unchanged', async () => {
    const user = await createTestUser(app);
    const headers = { Authorization: `Bearer ${tokenFor(app, user)}` };
    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set(headers).expect(200);
    expect(me.body).toEqual({ id: user.id, name: user.name, email: user.email, isAdmin: false });
    await request(app.getHttpServer()).get('/api/v1/projects').set(headers).expect(200);
  });
});
