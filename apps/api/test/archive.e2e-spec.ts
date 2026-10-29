import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHmac, randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import request from 'supertest';
import type { Repository } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { configureBodyParsing } from './../src/common/body-parser.js';
import { Feature } from './../src/feature/feature.entity.js';
import { IntakeItem } from './../src/intake/intake-item.entity.js';
import { SpecApproval } from './../src/spec/spec-approval.entity.js';
import { SpecVersion } from './../src/spec/spec-version.entity.js';
import { COPILOT_USER_KEY } from './../src/copilot/copilot.context.js';
import { createCopilotTools, type CopilotServices } from './../src/copilot/copilot.tools.js';
import { SpecService } from './../src/spec/spec.service.js';
import { authedAgent, createApiKey, createTestUser } from './helpers/auth.js';

const SECRET = 'archive-webhook-secret';
const specBody = [
  ['Goal', 'Ship it.'], ['Context', 'Why.'], ['Behaviour', 'How.'], ['Acceptance criteria', '- AC-1: First'],
  ['Out of scope', 'Nothing.'], ['Open questions', 'None'],
].map(([h, t]) => `## ${h}\n\n${t}\n`).join('\n');

describe('Archiving specs and intake items (e2e)', () => {
  let app: INestApplication;
  let http: Awaited<ReturnType<typeof authedAgent>>;
  let projectId: string;
  let repoId: string;
  let slug: string;
  const repo = <T extends object>(e: new () => T) => app.get<Repository<T>>(getRepositoryToken(e));

  beforeAll(async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('/api');
    configureBodyParsing(app);
    await app.init();
    http = await authedAgent(app);
    slug = `ar-${randomUUID().slice(0, 8)}`;
    projectId = (await http.post('/api/v1/projects').send({ slug, name: 'Archive' }).expect(201)).body.id;
    repoId = (await http.post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body.id;
  });
  afterAll(async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    await app.close();
  });

  const createSpec = async () =>
    (await http.post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: `s-${randomUUID().slice(0, 8)}`, title: 'A spec', body: specBody, expectedVersion: 0 }).expect(201)).body;
  let issueNo = 100;
  const createItem = async (): Promise<string> => {
    const number = ++issueNo;
    const body = JSON.stringify({
      action: 'opened', repository: { full_name: `o/${slug}` },
      issue: { number, node_id: `I_${number}`, html_url: `https://github.com/o/${slug}/issues/${number}`, title: 'Item', body: 'text', state: 'open', user: { login: 'octo' }, labels: [{ name: 'gilde:refine' }] },
    });
    await request(app.getHttpServer()).post('/api/webhooks/github').set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues').set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`).send(body).expect(200);
    return (await repo(IntakeItem).findOneByOrFail({ repoId, number })).id;
  };
  const link = (itemId: string, specId: string) => repo(IntakeItem).update({ id: itemId }, { specId });
  const specIds = async (query = '') => (await http.get(`/api/v1/projects/${projectId}/specs${query}`).expect(200)).body.map((s: { id: string }) => s.id);
  const itemIds = async (query = '') => (await http.get(`/api/v1/projects/${projectId}/intake${query}`).expect(200)).body.map((s: { id: string }) => s.id);

  it('refuses anonymous callers and API keys, for specs and items', async () => {
    const spec = await createSpec();
    const id = await createItem();
    const key = await createApiKey(app, await createTestUser(app));
    for (const url of [`/api/v1/specs/${spec.id}/archive`, `/api/v1/specs/${spec.id}/unarchive`, `/api/v1/intake/${id}/archive`, `/api/v1/intake/${id}/unarchive`]) {
      await request(app.getHttpServer()).post(url).expect(401);
      await request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${key}`).expect(401);
    }
    expect((await http.get(`/api/v1/specs/${spec.id}`).expect(200)).body.archivedAt).toBeNull();
  });

  it('archives and unarchives a spec without touching its versions or approvals', async () => {
    const spec = await createSpec();
    await http.post(`/api/v1/specs/${spec.id}/approve`).send({ expectedVersion: 1 }).expect(200);
    const archived = (await http.post(`/api/v1/specs/${spec.id}/archive`).expect(200)).body;
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(archived).toMatchObject({ status: 'approved', currentVersion: 1, approvedVersion: 1 });

    expect(await specIds()).not.toContain(spec.id);
    expect(await specIds('?archived=true')).toEqual([spec.id]);
    expect((await http.get(`/api/v1/specs/${spec.id}`).expect(200)).body.archivedAt).toBe(archived.archivedAt);
    expect(await repo(SpecVersion).countBy({ specId: spec.id })).toBe(1);
    expect(await repo(SpecApproval).countBy({ specId: spec.id })).toBe(1);
    await http.get(`/api/v1/projects/${projectId}/specs?archived=bogus`).expect(400);

    const restored = (await http.post(`/api/v1/specs/${spec.id}/unarchive`).expect(200)).body;
    expect(restored.archivedAt).toBeNull();
    expect(await specIds()).toContain(spec.id);
    expect(await specIds('?archived=true')).not.toContain(spec.id);
    await http.post(`/api/v1/specs/${randomUUID()}/archive`).expect(404);
  });

  it('refuses to archive a spec a feature has pinned, naming the feature', async () => {
    const spec = await createSpec();
    const feature = await repo(Feature).save(repo(Feature).create({ projectId, title: 'Pinning feature', spec: 'x', specId: spec.id, specVersion: 1 }));
    const res = await http.post(`/api/v1/specs/${spec.id}/archive`).expect(409);
    expect(res.body.message).toContain('Pinning feature');
    expect(res.body.message).toContain(feature.id);
    expect(await specIds()).toContain(spec.id);
  });

  it('archives an item with its spec, hides both and restores both', async () => {
    const spec = await createSpec();
    const id = await createItem();
    await link(id, spec.id);
    const archived = (await http.post(`/api/v1/intake/${id}/archive`).expect(200)).body;
    expect(archived).toMatchObject({ status: 'new', specId: spec.id, spec: { archivedAt: expect.any(String) } });
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(await itemIds()).not.toContain(id);
    expect(await itemIds('?archived=true')).toEqual([id]);
    expect(await specIds()).not.toContain(spec.id);
    expect((await http.get(`/api/v1/intake/${id}`).expect(200)).body.archivedAt).toBe(archived.archivedAt);

    const restored = (await http.post(`/api/v1/intake/${id}/unarchive`).expect(200)).body;
    expect(restored.archivedAt).toBeNull();
    expect(await itemIds()).toContain(id);
    expect(await specIds()).toContain(spec.id);
  });

  it('archives an item whose spec is pinned, leaving the spec alone', async () => {
    const spec = await createSpec();
    const id = await createItem();
    await link(id, spec.id);
    await repo(Feature).save(repo(Feature).create({ projectId, title: 'Pinning', spec: 'x', specId: spec.id, specVersion: 1 }));
    expect((await http.post(`/api/v1/intake/${id}/archive`).expect(200)).body.archivedAt).toEqual(expect.any(String));
    expect(await specIds()).toContain(spec.id);
    await http.post(`/api/v1/intake/${id}/unarchive`).expect(200);
    expect(await specIds()).toContain(spec.id);
  });

  it('does not unarchive a spec that was archived on its own when its item is unarchived', async () => {
    const spec = await createSpec();
    const id = await createItem();
    await link(id, spec.id);
    await http.post(`/api/v1/specs/${spec.id}/archive`).expect(200);
    await http.post(`/api/v1/intake/${id}/archive`).expect(200);
    await http.post(`/api/v1/intake/${id}/unarchive`).expect(200);
    expect(await specIds()).not.toContain(spec.id);
  });

  it('keeps archived specs out of the co-pilot listSpecs tool', async () => {
    const spec = await createSpec();
    const listed = async () => {
      const requestContext = new RequestContext();
      requestContext.set(COPILOT_USER_KEY, { id: randomUUID(), name: 'A', email: 'a@example.com', credential: 'jwt' });
      const tools = createCopilotTools({ specs: app.get(SpecService) } as unknown as CopilotServices);
      return ((tools.listSpecs.execute as (i: unknown, c: unknown) => Promise<{ id: string }[]>)({ projectId }, { requestContext })).then((l) => l.map((x) => x.id));
    };
    expect(await listed()).toContain(spec.id);
    await http.post(`/api/v1/specs/${spec.id}/archive`).expect(200);
    expect(await listed()).not.toContain(spec.id);
  });
});
