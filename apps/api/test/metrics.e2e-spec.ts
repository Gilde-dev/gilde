import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { authedAgent } from './helpers/auth.js';
import { JOB_STATUSES } from './../src/job/job-state.js';

describe('Metrics (e2e)', () => {
  let app: INestApplication<App>;
  let http: Awaited<ReturnType<typeof authedAgent>>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1/metrics returns the documented shape', async () => {
    const res = await http.get('/api/v1/metrics?days=7').expect(200);
    expect(res.body.days).toBe(7);
    expect(Object.keys(res.body.jobs.countByStatus)).toEqual([...JOB_STATUSES]);
    expect(res.body).toHaveProperty('mergeRate');
    expect(res.body).toHaveProperty('firstPassRate');
    expect(res.body).toHaveProperty('avgAttempts');
    expect(res.body.timeToMerge).toHaveProperty('median');
    expect(res.body.timeToMerge).toHaveProperty('p90');
    expect(Object.keys(res.body.runs.byOutcome)).toEqual(['done', 'partial', 'blocked', 'none']);
    expect(res.body.runs.byCiConclusion).toHaveProperty('none');
    expect(res.body.runs).toHaveProperty('gateFailures');
    expect(res.body.daily).toHaveLength(7);
    expect(res.body.daily[0]).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), created: expect.any(Number), merged: expect.any(Number), parked: expect.any(Number) });
  });

  it('returns 404 for an unknown repoId', () => {
    return http
      .get('/api/v1/metrics?repoId=00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('returns 400 for days out of range', () => {
    return http.get('/api/v1/metrics?days=366').expect(400);
  });
});
