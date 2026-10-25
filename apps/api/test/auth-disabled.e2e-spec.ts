import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('Auth disabled (e2e)', () => {
  let app: INestApplication<App>;
  const previous = { enabled: process.env.AUTH_ENABLED, secret: process.env.JWT_SECRET };

  beforeEach(async () => {
    process.env.AUTH_ENABLED = 'false';
    delete process.env.JWT_SECRET;
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const [key, value] of [['AUTH_ENABLED', previous.enabled], ['JWT_SECRET', previous.secret]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('lets requests through without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/projects').expect(200);
  });
});
