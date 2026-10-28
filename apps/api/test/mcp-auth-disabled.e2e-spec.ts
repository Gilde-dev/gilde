process.env.MCP_ENABLED = 'true';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

describe('MCP with AUTH_ENABLED=false (e2e)', () => {
  let app: INestApplication;
  const previous = { enabled: process.env.AUTH_ENABLED, secret: process.env.JWT_SECRET };

  beforeAll(async () => {
    process.env.AUTH_ENABLED = 'false';
    delete process.env.JWT_SECRET;
    const { AppModule } = await import('./../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of [['AUTH_ENABLED', previous.enabled], ['JWT_SECRET', previous.secret]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('lets the protocol through but fails every tool closed: there is no verified identity to act as', async () => {
    const rpc = (body: object) => request(app.getHttpServer()).post('/api/v1/mcp').set('Accept', 'application/json, text/event-stream').send(body);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    for (const [name, args] of [['listProjects', {}], ['createJob', { repoId: '33333333-3333-4333-8333-333333333333', title: 'Add a thing', task: 'Do the thing properly', acceptanceCriteria: ['It works well'] }]] as const) {
      const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toContain('Not allowed');
    }
  });
});
