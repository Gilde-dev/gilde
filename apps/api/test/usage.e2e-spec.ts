import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { UsageService } from './../src/usage/usage.service.js';
import { authedAgent } from './helpers/auth.js';

describe('Usage (e2e)', () => {
  let app: INestApplication<App>;
  let http: Awaited<ReturnType<typeof authedAgent>>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1/usage returns totals, a daily series and breakdowns', async () => {
    await app.get(UsageService).record({ kind: 'chat', model: 'openai/e2e-model', inputTokens: 10, outputTokens: 5 });
    const res = await http.get('/api/v1/usage?days=7').expect(200);
    expect(res.body.days).toBe(7);
    expect(res.body.totals.totalTokens).toBeGreaterThanOrEqual(15);
    expect(res.body.daily).toHaveLength(7);
    expect(res.body.byModel.some((m: { model: string }) => m.model === 'openai/e2e-model')).toBe(true);
    expect(res.body).toHaveProperty('byKind');
    expect(res.body).toHaveProperty('byUser');
    await http.get('/api/v1/usage?kind=nope').expect(400);
  });
});
