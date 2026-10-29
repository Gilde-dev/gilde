import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { FeaturePlanService } from './../src/copilot/feature-plan.service.js';
import { Feature } from './../src/feature/feature.entity.js';
import { GITHUB_PORT, GitHubRequestError, type GitHubPort } from './../src/github/github.port.js';
import { IntakeCommentService } from './../src/intake/intake-comment.service.js';
import { IntakeItem } from './../src/intake/intake-item.entity.js';
import { authedAgent } from './helpers/auth.js';

const specBody = ['Goal: Export the list as CSV.', 'Context: Why.', 'Behaviour: How.', 'Acceptance criteria: - AC-1: First\n- AC-2: Second',
  'Out of scope: Nothing.', 'Open questions: None'].map((s) => { const i = s.indexOf(': '); return `## ${s.slice(0, i)}\n\n${s.slice(i + 2)}\n`; }).join('\n');

describe('Intake status comment says planned when a feature is planned from the spec (e2e), mocked GitHubPort', () => {
  let app: INestApplication;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let comments: IntakeCommentService;
  let plans: FeaturePlanService;
  let clock: Date;
  let failWith: GitHubRequestError | null = null;
  let upserts: { fullName: string; number: number; marker: string; body: string; commentId: string | null }[] = [];
  let projectId: string;
  let repoId: string;
  let repoRow: string;

  const fakeGithub = {
    isConfigured: () => true,
    upsertIssueComment: async (repo: string, number: number, input: { marker: string; body: string; commentId: string | null }) => {
      if (failWith) throw failWith;
      upserts.push({ fullName: repo, number, ...input });
      return { id: '9001', htmlUrl: `https://github.com/${repo}/issues/${number}#issuecomment-9001` };
    },
    listOpenIssuesWithLabel: async () => ({ issues: [], complete: true }),
  } as unknown as GitHubPort;

  const items = () => app.get<Repository<IntakeItem>>(getRepositoryToken(IntakeItem));
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  const settle = () => new Promise((r) => setTimeout(r, 150));

  beforeAll(async () => {
    process.env.WEB_ORIGIN = 'http://web.test';
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(GITHUB_PORT).useValue(fakeGithub).compile()).createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    http = await authedAgent(app);
    comments = app.get(IntakeCommentService);
    plans = app.get(FeaturePlanService);
  });
  afterAll(async () => { delete process.env.WEB_ORIGIN; await app.close(); });

  beforeEach(async () => {
    failWith = null;
    upserts = [];
    clock = new Date('2026-10-29T10:00:00Z');
    comments.now = () => clock;
    const slug = `ip-${randomUUID().slice(0, 8)}`;
    projectId = (await http.post('/api/v1/projects').send({ slug, name: 'Planned' }).expect(201)).body.id;
    repoId = (await http.post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    repoRow = `o/${slug}`;
  });

  const approvedSpec = async () => {
    const created = (await http.post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: `s-${randomUUID().slice(0, 8)}`, title: 'Export to CSV', body: specBody, expectedVersion: 0 }).expect(201)).body;
    const detail = (await http.post(`/api/v1/specs/${created.id}/approve`).send({ expectedVersion: 1 }).expect(200)).body;
    return { id: created.id as string, token: { version: 1, approvalId: detail.versions[0].approval.id as string } };
  };
  const linkedItem = async (specId: string, number = 5) => items().save(items().create({
    projectId, repoId, source: 'github_issue', externalId: `I_${randomUUID()}`, number, url: `https://github.com/${repoRow}/issues/${number}`,
    title: 'Export', body: 'b', bodySha256: 'a'.repeat(64), status: 'drafted', specId,
  }));
  const draft = (extra: Record<string, unknown> = {}) => ({
    projectId, title: 'Planned feature', spec: 'Build it.', acceptanceCriteria: ['Works'],
    jobs: [{ key: 'api', repoId, title: 'Job api', task: 'First run `git fetch origin && git rebase origin/main`. Do api.', acceptanceCriteria: ['api works'], dependsOn: [] }],
    ...extra,
  });

  it('updates the status comment to planned with the link to the spec of the feature', async () => {
    const spec = await approvedSpec();
    const item = await linkedItem(spec.id);
    await comments.sync(item.id);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].body).toContain('**approved**');

    advance(2 * 60_000);
    const result = await plans.create(draft({ specId: spec.id, specApproval: spec.token }), null);
    expect(result.created).toBe(true);
    for (let i = 0; i < 50 && upserts.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(upserts).toHaveLength(2);
    expect(upserts[1]).toMatchObject({ fullName: repoRow, number: 5, commentId: '9001', marker: `<!-- gilde:intake:${item.id} -->` });
    expect(upserts[1].body).toContain('**planned**');
    expect(upserts[1].body).toContain(`http://web.test/specs/${spec.id}?project=${projectId}`);
    expect(await app.get<Repository<Feature>>(getRepositoryToken(Feature)).countBy({ specId: spec.id })).toBe(1);
    expect(await items().findOneByOrFail({ id: item.id })).toMatchObject({ commentError: null });
  });

  it('writes no comment for a plan without a spec', async () => {
    const spec = await approvedSpec();
    await linkedItem(spec.id);
    const result = await plans.create(draft(), null);
    expect(result.created).toBe(true);
    await settle();
    expect(upserts).toHaveLength(0);
  });

  it('writes no comment for a plan rejected as stale or unapproved', async () => {
    const spec = await approvedSpec();
    await linkedItem(spec.id);
    const stale = await plans.create(draft({ specId: spec.id, specApproval: { version: 1, approvalId: randomUUID() } }), null);
    expect(stale.created).toBe(false);
    const unapproved = (await http.post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: `u-${randomUUID().slice(0, 8)}`, title: 'Draft', body: specBody, expectedVersion: 0 }).expect(201)).body;
    await linkedItem(unapproved.id, 6);
    const refused = await plans.create(draft({ specId: unapproved.id, specApproval: { version: 1, approvalId: spec.token.approvalId } }), null);
    expect(refused.created).toBe(false);
    await settle();
    expect(upserts).toHaveLength(0);
  });

  it('keeps the plan and records commentError when the comment write fails', async () => {
    const spec = await approvedSpec();
    const item = await linkedItem(spec.id);
    failWith = new GitHubRequestError('GitHub PATCH failed: 403', 403);
    const result = await plans.create(draft({ specId: spec.id, specApproval: spec.token }), null);
    expect(result.created).toBe(true);
    let current = await items().findOneByOrFail({ id: item.id });
    for (let i = 0; i < 50 && !current.commentError; i++) { await new Promise((r) => setTimeout(r, 20)); current = await items().findOneByOrFail({ id: item.id }); }
    expect(current.commentError).toContain('Issues: write');
    expect(upserts).toHaveLength(0);
    const featureId = (result as { featureId: string }).featureId;
    expect((await http.get(`/api/v1/features/${featureId}`).expect(200)).body).toMatchObject({ id: featureId, status: 'draft' });
  });

  it('writes the planned update once: a second plan renders the same comment and does not write again', async () => {
    const spec = await approvedSpec();
    const item = await linkedItem(spec.id);
    expect((await plans.create(draft({ specId: spec.id, specApproval: spec.token }), null)).created).toBe(true);
    for (let i = 0; i < 50 && upserts.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].body).toContain('**planned**');

    advance(5 * 60_000);
    expect((await plans.create(draft({ specId: spec.id, specApproval: spec.token }), null)).created).toBe(true);
    await settle();
    expect(upserts).toHaveLength(1);
    expect(await items().findOneByOrFail({ id: item.id })).toMatchObject({ statusCommentPending: false, commentError: null });
  });

  it('holds a planned update back inside the rate-limit minute and writes it from the pending flush', async () => {
    const spec = await approvedSpec();
    const item = await linkedItem(spec.id);
    await comments.sync(item.id);
    expect(upserts).toHaveLength(1);
    advance(10_000);
    await plans.create(draft({ specId: spec.id, specApproval: spec.token }), null);
    await settle();
    expect(upserts).toHaveLength(1);
    expect(await items().findOneByOrFail({ id: item.id })).toMatchObject({ statusCommentPending: true });
    advance(61_000);
    await comments.flushPending();
    expect(upserts).toHaveLength(2);
    expect(upserts[1].body).toContain('**planned**');
  });
});
