import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types.js';

import { AppModule } from './../src/app.module.js';
import { Repo } from './../src/repo/repo.entity.js';
import { EXECUTION_PORT, type ExecutionPort } from './../src/execution/execution.port.js';
import { prepareJobPrompt } from './../src/execution/job-prompt.js';
import { GITHUB_PORT, type GitHubPort } from './../src/github/github.port.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

describe('Dispatch in bootstrap mode (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let repoId: string;
  let payloads: Record<string, unknown>[];
  let manifestFile: { content: string; sha: string } | null;
  const previousKey = process.env.EXECUTOR_SECRET_KEY;
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${tokenFor(app, ann)}` });

  beforeEach(async () => {
    process.env.EXECUTOR_SECRET_KEY = randomBytes(32).toString('base64');
    payloads = [];
    manifestFile = null;
    const execution: ExecutionPort = {
      prepare: (payload, context) => prepareJobPrompt(payload, { text: null, version: null }, context),
      fire: async (_target, input) => {
        payloads.push(('prepared' in input ? input.payload : input) as unknown as Record<string, unknown>);
        return { sessionId: 's', sessionUrl: 'https://claude.ai/code/s' };
      },
    };
    const github = { isConfigured: () => true, getFileContent: async () => manifestFile, getBranchHeadSha: async () => 'sha' } as unknown as GitHubPort;
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EXECUTION_PORT).useValue(execution)
      .overrideProvider(GITHUB_PORT).useValue(github)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = randomBytes(4).toString('hex');
    const project = (await http().post('/api/v1/projects').set(auth()).send({ name: `P ${slug}`, slug: `p-${slug}` })).body;
    repoId = (await http().post(`/api/v1/projects/${project.id}/repos`).set(auth()).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    await app.get(DataSource).getRepository(Repo).update({ id: repoId }, { maxConcurrentJobs: 5 });
    await http().post('/api/v1/executors').set(auth()).send({
      name: 'ann', fireUrl: 'https://api.anthropic.com/v1/claude_code/routines/x/fire', token: 'sk-ant-oat01-BOOT-1', repoIds: [repoId], maxConcurrent: 2,
    }).expect(201);
  });

  afterEach(async () => {
    await app.close();
    if (previousKey === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = previousKey;
  });

  const queueJob = async () => {
    const job = (await http().post(`/api/v1/repos/${repoId}/jobs`).set(auth()).send({ title: 'Bootstrap', task: 'Create the manifest', status: 'triage' }).expect(201)).body;
    await http().post(`/api/v1/jobs/${job.id}/enqueue`).set(auth()).expect(200);
    return job;
  };
  const report = async () => (await http().post('/api/v1/dispatch').set(auth()).expect(201)).body.repos.find((r: { repoId: string }) => r.repoId === repoId);

  it('refreshes to missing, then fires with the bootstrap reason, empty commands and a note', async () => {
    expect((await http().post(`/api/v1/repos/${repoId}/manifest/refresh`).set(auth()).expect(200)).body.manifestStatus).toBe('missing');
    await queueJob();
    expect(await report()).toMatchObject({ fired: 1, reason: 'no_manifest_bootstrap', detail: '.gilde.json not found; jobs run in bootstrap mode' });
    expect(payloads[0]).toMatchObject({ testCommands: [], stacks: [] });
    expect(String(payloads[0].bootstrapNote)).toContain('no .gilde.json yet');
  });

  it('keeps blocking an invalid manifest', async () => {
    manifestFile = { content: '{nope', sha: 'x' };
    expect((await http().post(`/api/v1/repos/${repoId}/manifest/refresh`).set(auth()).expect(200)).body.manifestStatus).toBe('invalid');
    await queueJob();
    expect(await report()).toMatchObject({ fired: 0, reason: 'no_manifest' });
    expect(payloads).toEqual([]);
  });
});
