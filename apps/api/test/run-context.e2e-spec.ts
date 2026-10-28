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
import { hashText } from './../src/run/run-context.js';
import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';

describe('Run context (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let repoId: string;
  let fired: number;
  let githubFails: boolean;
  const previousKey = process.env.EXECUTOR_SECRET_KEY;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => ({ Authorization: `Bearer ${tokenFor(app, u)}` });

  const files: Record<string, string> = {
    '.claude/skills/.gildeboek-version': 'v9.9.9\n',
    'AGENTS.md': '# agents',
    '.claude/skills/alpha/SKILL.md': '---\nname: alpha\nmanaged-by: gildeboek@v9.9.9\n---\nA\n',
    '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\nM\n',
  };
  const github = {
    isConfigured: () => true,
    getBranchHeadSha: async () => {
      if (githubFails) throw new Error('GitHub GET /repos/o/r/commits/main failed: 500');
      return 'sha-e2e';
    },
    getFileContent: async (_f: string, path: string) => (path in files ? { content: files[path], sha: 'x' } : null),
    listDirectory: async (_f: string, path: string) => {
      if (path === '.claude/skills') {
        return ['alpha', 'mine'].map((name) => ({ name, path: `.claude/skills/${name}`, type: 'dir' as const }));
      }
      return `${path}/SKILL.md` in files ? [{ name: 'SKILL.md', path: `${path}/SKILL.md`, type: 'file' as const }] : null;
    },
  } as unknown as GitHubPort;

  beforeEach(async () => {
    process.env.EXECUTOR_SECRET_KEY = randomBytes(32).toString('base64');
    fired = 0;
    githubFails = false;
    const execution: ExecutionPort = {
      prepare: (payload, context) => prepareJobPrompt(payload, { text: null, version: null }, context),
      fire: async () => { fired++; return { sessionId: `s-${fired}`, sessionUrl: 'https://claude.ai/code/s' }; },
    };
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EXECUTION_PORT).useValue(execution)
      .overrideProvider(GITHUB_PORT).useValue(github)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = randomBytes(4).toString('hex');
    const project = (await http().post('/api/v1/projects').set(as(ann)).send({ name: `P ${slug}`, slug: `p-${slug}` })).body;
    repoId = (await http().post(`/api/v1/projects/${project.id}/repos`).set(as(ann)).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    await app.get(DataSource).getRepository(Repo).update({ id: repoId }, { testCommands: ['pnpm test'], stacks: ['node'], maxConcurrentJobs: 5 });
    await http().post('/api/v1/executors').set(as(ann)).send({
      name: 'ann-main', fireUrl: 'https://api.anthropic.com/v1/claude_code/routines/x/fire', token: 'sk-ant-oat01-CTXSECRET-1a1a', repoIds: [repoId], maxConcurrent: 2,
    }).expect(201);
  });

  afterEach(async () => {
    await app.close();
    if (previousKey === undefined) delete process.env.EXECUTOR_SECRET_KEY;
    else process.env.EXECUTOR_SECRET_KEY = previousKey;
  });

  const runOneJob = async () => {
    const job = (await http().post(`/api/v1/repos/${repoId}/jobs`).set(as(ann)).send({ title: 'Ctx', task: 'Do ctx please', status: 'queued' }).expect(201)).body;
    await http().post('/api/v1/dispatch').set(as(ann)).expect(201);
    return (await http().get(`/api/v1/jobs/${job.id}`).set(as(ann)).expect(200)).body.runs[0];
  };

  it('stores the skills, gildeboek version and AGENTS.md hash of the fired run and exposes them', async () => {
    const run = await runOneJob();
    expect(fired).toBe(1);
    expect(run.contextError).toBeNull();
    expect(run.context).toMatchObject({ gildeboekVersion: 'v9.9.9', agentsMdHash: hashText('# agents') });
    expect(run.context.skills).toEqual([
      { name: 'alpha', hash: expect.stringMatching(/^[0-9a-f]{64}$/), managedBy: 'gildeboek@v9.9.9' },
      { name: 'mine', hash: expect.stringMatching(/^[0-9a-f]{64}$/), managedBy: null },
    ]);
    expect(new Date(run.context.capturedAt).getTime()).not.toBeNaN();
  });

  it('still fires when GitHub fails and records context null plus contextError', async () => {
    githubFails = true;
    const run = await runOneJob();
    expect(fired).toBe(1);
    expect(run.status).toBe('fired');
    expect(run.context).toBeNull();
    expect(run.contextError).toContain('failed: 500');
  });
});
