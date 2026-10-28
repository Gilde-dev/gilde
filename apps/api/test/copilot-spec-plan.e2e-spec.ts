import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RequestContext } from '@mastra/core/request-context';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { randomUUID } from 'node:crypto';
import { EntityManager, type Repository } from 'typeorm';

import { createTestUser, tokenFor, type TestUser } from './helpers/auth.js';
import { AppModule } from './../src/app.module.js';
import { COPILOT_USER_KEY } from './../src/copilot/copilot.context.js';
import { createCopilotTools, type CopilotServices } from './../src/copilot/copilot.tools.js';
import { FeaturePlanService } from './../src/copilot/feature-plan.service.js';
import { Feature } from './../src/feature/feature.entity.js';
import { Job } from './../src/job/job.entity.js';
import { JobDependency } from './../src/job/job-dependency.entity.js';
import { JobService } from './../src/job/job.service.js';
import { SpecApproval } from './../src/spec/spec-approval.entity.js';
import { SpecRecording } from './../src/spec/spec-recording.entity.js';
import { SpecService } from './../src/spec/spec.service.js';
import { Spec } from './../src/spec/spec.entity.js';
import { SpecVersion } from './../src/spec/spec-version.entity.js';

const body = (goal = 'Ship it.') =>
  Object.entries({
    Goal: goal, Context: 'Why.', Behaviour: 'How.',
    'Acceptance criteria': '- AC-1: First\n- AC-2: Second',
    'Out of scope': 'Nothing.', 'Open questions': 'None',
  }).map(([h, t]) => `## ${h}\n\n${t}\n`).join('\n');

describe('Co-pilot drafting and version-pinned planning (e2e)', () => {
  let app: INestApplication<App>;
  let ann: TestUser;
  let projectId: string;
  let repoId: string;
  let otherRepoId: string;
  const as = (u: TestUser) => request.agent(app.getHttpServer()).set({ Authorization: `Bearer ${tokenFor(app, u)}` });
  const repo = <T extends object>(e: new () => T) => app.get<Repository<T>>(getRepositoryToken(e));

  const tools = () => createCopilotTools({ specs: app.get(SpecService), plans: app.get(FeaturePlanService) } as unknown as CopilotServices);
  const exec = (name: 'draftSpec' | 'getSpec' | 'planFeature' | 'createPlannedFeature', input: unknown, user: unknown = { id: ann.id, name: ann.name, email: ann.email, credential: 'jwt' }) => {
    const requestContext = new RequestContext();
    requestContext.set(COPILOT_USER_KEY, user);
    return (tools()[name].execute as (i: unknown, c: unknown) => Promise<any>)(input, { requestContext });
  };

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.listen(0);
    ann = await createTestUser(app, { name: 'Ann' });
    const slug = `sp-${randomUUID().slice(0, 8)}`;
    projectId = (await as(ann).post('/api/v1/projects').send({ slug, name: 'Plan project' }).expect(201)).body.id;
    repoId = (await as(ann).post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug}` }).expect(201)).body.id;
    otherRepoId = (await as(ann).post(`/api/v1/projects/${projectId}/repos`).send({ fullName: `o/${slug}-web` }).expect(201)).body.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createSpec = async (text = body()) =>
    (await as(ann).post(`/api/v1/projects/${projectId}/specs`).send({ repoId, slug: `s-${randomUUID().slice(0, 8)}`, title: 'A spec', body: text, expectedVersion: 0 }).expect(201)).body;
  const save = async (id: string, text: string, expectedVersion: number) =>
    (await as(ann).post(`/api/v1/specs/${id}/versions`).send({ title: 'A spec', body: text, expectedVersion }).expect(201)).body;
  const approve = async (id: string, expectedVersion: number) =>
    (await as(ann).post(`/api/v1/specs/${id}/approve`).send({ expectedVersion }).expect(200)).body;
  const approvedSpec = async () => {
    const created = await createSpec();
    const detail = await approve(created.id, 1);
    return { id: created.id as string, detail, token: { version: 1, approvalId: detail.versions[0].approval.id as string } };
  };
  const job = (key: string, dependsOn: string[] = [], repo = repoId) => ({
    key, repoId: repo, title: `Job ${key}`, task: `First run \`git fetch origin && git rebase origin/main\`. Do ${key}.`,
    acceptanceCriteria: [`${key} works`], dependsOn,
  });
  const plan = (extra: Record<string, unknown> = {}, jobs = [job('api'), job('web', ['api'], otherRepoId)]) => ({
    projectId, title: 'Planned feature', spec: 'Build the thing.', acceptanceCriteria: ['The thing works'], jobs, ...extra,
  });
  const counts = async () => ({
    features: await repo(Feature).count(),
    jobs: await repo(Job).count(),
    edges: await repo(JobDependency).count(),
    pinned: (await repo(SpecRecording).find()).filter((r) => r.pinnedByFeatureId).length,
  });

  describe('draftSpec', () => {
    it('saves drafts as the request-context user and never approves', async () => {
      const created = await exec('draftSpec', { projectId, repoId, slug: 'dark-mode', title: 'Dark mode', body: body(), expectedVersion: 0, createdBy: randomUUID() });
      expect(created).toMatchObject({ saved: true, version: 1, status: 'draft', approved: false });
      const second = await exec('draftSpec', { specId: created.specId, title: 'Dark mode', body: body('Changed.'), expectedVersion: 1 });
      expect(second).toMatchObject({ saved: true, version: 2, status: 'draft' });
      const stored = await repo(Spec).findOneByOrFail({ id: created.specId });
      expect(stored).toMatchObject({ createdById: ann.id, updatedById: ann.id, status: 'draft', approvedVersion: null });
      expect(await repo(SpecApproval).count({ where: { specId: created.specId } })).toBe(0);
      expect(await repo(SpecRecording).count({ where: { specId: created.specId } })).toBe(0);
    });

    it('refuses a stale expectedVersion and writes nothing', async () => {
      const created = await createSpec();
      await save(created.id, body('v2'), 1);
      const result = await exec('draftSpec', { specId: created.id, title: 'A spec', body: body('late'), expectedVersion: 1 });
      expect(result.saved).toBe(false);
      expect(await repo(SpecVersion).count({ where: { specId: created.id } })).toBe(2);
    });

    it('writes nothing without a user in the request context', async () => {
      const specsBefore = await repo(Spec).count();
      const result = await exec('draftSpec', { projectId, repoId, slug: 'nope', title: 'Nope', body: body(), expectedVersion: 0 }, null);
      expect(result).toEqual({ saved: false, problems: ['No authenticated user'] });
      expect(await repo(Spec).count()).toBe(specsBefore);
    });
  });

  describe('planning from an approved version', () => {
    it('pins the version, links the jobs to the recording and puts the spec context after the rebase line', async () => {
      const spec = await approvedSpec();
      const input = plan({ specId: spec.id, specApproval: spec.token });
      const valid = await exec('planFeature', input);
      expect(valid).toMatchObject({ valid: true, spec: { version: 1, slug: spec.detail.slug, recordingState: 'triage' } });

      const result = await exec('createPlannedFeature', input);
      expect(result.created).toBe(true);
      const feature = (await as(ann).get(`/api/v1/features/${result.featureId}`).expect(200)).body;
      const version = spec.detail.versions[0];
      expect(feature.pinnedSpec).toMatchObject({
        specId: spec.id, version: 1, slug: spec.detail.slug, bodySha256: version.bodySha256, approvalId: version.approval.id,
        recordingJobId: version.recording.jobId, repoId, path: `docs/specs/${spec.detail.slug}.md`,
      });
      expect(feature.status).toBe('draft');
      expect(feature.jobs).toHaveLength(2);
      for (const j of feature.jobs) {
        expect(j.status).toBe('triage');
        expect(j.createdBy.id).toBe(ann.id);
        expect(j.dependsOn).toContain(version.recording.jobId);
        expect(j.task.startsWith('First run `git fetch origin && git rebase origin/main`.\n\n## Approved spec (pinned)')).toBe(true);
        expect(j.task).toContain(version.bodySha256);
        expect(j.task).toContain(version.recording.jobId);
      }
      const api = feature.jobs.find((j: any) => j.title === 'Job api');
      const web = feature.jobs.find((j: any) => j.title === 'Job web');
      expect(api.task).toContain('in this repo');
      expect(web.task).toContain('NOT in this repo');
      expect(web.task).toContain('git log --format=%H');
      expect(web.dependsOn).toEqual(expect.arrayContaining([api.id, version.recording.jobId]));
      expect((await repo(SpecRecording).findOneByOrFail({ id: version.recording.id })).pinnedByFeatureId).toBe(feature.id);
    });

    it('keeps the pin when later drafts and approvals arrive, and refuses to plan again from the old version', async () => {
      const spec = await approvedSpec();
      const input = plan({ specId: spec.id, specApproval: spec.token });
      const { featureId } = await exec('createPlannedFeature', input);
      const before = (await as(ann).get(`/api/v1/features/${featureId}`).expect(200)).body;

      await save(spec.id, body('Changed.'), 1);
      const approved2 = await approve(spec.id, 2);
      const after = (await as(ann).get(`/api/v1/features/${featureId}`).expect(200)).body;
      expect(after.pinnedSpec).toEqual(before.pinnedSpec);
      expect(after.jobs.map((j: any) => j.task)).toEqual(before.jobs.map((j: any) => j.task));
      expect((await repo(Feature).findOneByOrFail({ id: featureId })).specPin?.body).toBe(body());

      const stale = await exec('createPlannedFeature', input);
      expect(stale.created).toBe(false);
      expect(stale.problems.join()).toMatch(/superseded by approved version 2/);
      const fresh = await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: { version: 2, approvalId: approved2.versions[0].approval.id } }));
      expect(fresh.created).toBe(true);
      expect((await as(ann).get(`/api/v1/features/${fresh.featureId}`).expect(200)).body.pinnedSpec.version).toBe(2);
    });

    it('refuses unapproved, unmatched, other-project and unknown targets and writes nothing', async () => {
      const draftOnly = await createSpec();
      const approved = await approvedSpec();
      const before = await counts();
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ specId: draftOnly.id, specApproval: { version: 1, approvalId: randomUUID() } }, /no approved version/],
        [{ specId: approved.id, specApproval: { version: 2, approvalId: approved.token.approvalId } }, /has no version 2/],
        [{ specId: approved.id, specApproval: { version: 1, approvalId: randomUUID() } }, /another approval/],
        [{ specId: randomUUID(), specApproval: approved.token }, /Unknown spec/],
      ];
      for (const [extra, problem] of cases) {
        const validated = await exec('planFeature', plan(extra));
        expect(validated.valid).toBe(false);
        expect(validated.problems.join()).toMatch(problem);
        const created = await exec('createPlannedFeature', plan(extra));
        expect(created.created).toBe(false);
      }
      expect(await counts()).toEqual(before);

      const otherProject = (await as(ann).post('/api/v1/projects').send({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' }).expect(201)).body.id;
      const result = await exec('planFeature', { ...plan({ specId: approved.id, specApproval: approved.token }), projectId: otherProject });
      expect(result.valid).toBe(false);
    });

    it('lets a draft after the approval stay out of the way: the approved version can still be planned', async () => {
      const spec = await approvedSpec();
      await save(spec.id, body('Next.'), 1);
      expect((await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }))).created).toBe(true);
    });

    it('lets two features pin the same version', async () => {
      const spec = await approvedSpec();
      const a = await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }));
      const b = await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }));
      expect(a.created && b.created).toBe(true);
      expect((await repo(SpecRecording).findOneByOrFail({ id: spec.detail.versions[0].recording.id })).pinnedByFeatureId).toBe(a.featureId);
    });

    it('names a cancelled recording job as a blocker', async () => {
      const spec = await approvedSpec();
      await app.get(JobService).cancel(spec.detail.versions[0].recording.jobId);
      const result = await exec('planFeature', plan({ specId: spec.id, specApproval: spec.token }));
      expect(result.valid).toBe(false);
      expect(result.problems.join()).toMatch(/recording job .* is cancelled/);
      expect((await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }))).created).toBe(false);
    });

    it('rechecks the shown token inside the transaction when a newer version is approved after validation', async () => {
      const spec = await approvedSpec();
      const input = plan({ specId: spec.id, specApproval: spec.token });
      expect((await exec('planFeature', input)).valid).toBe(true);
      await save(spec.id, body('Changed.'), 1);
      await approve(spec.id, 2);
      const before = await counts();
      const result = await exec('createPlannedFeature', input);
      expect(result).toMatchObject({ created: false });
      expect(await counts()).toEqual(before);
    });

    it('keeps plans without a spec as they were', async () => {
      const result = await exec('createPlannedFeature', plan());
      expect(result.created).toBe(true);
      const feature = (await as(ann).get(`/api/v1/features/${result.featureId}`).expect(200)).body;
      expect(feature.pinnedSpec).toBeNull();
      expect(feature.jobs.map((j: any) => j.task).sort()).toEqual(['First run `git fetch origin && git rebase origin/main`. Do api.', 'First run `git fetch origin && git rebase origin/main`. Do web.']);
      expect(feature.jobs.find((j: any) => j.title === 'Job web').dependsOn).toEqual([feature.jobs.find((j: any) => j.title === 'Job api').id]);
      expect(await as(ann).get('/api/v1/features?projectId=' + projectId).catch(() => null)).not.toBeNull();
    });

    it('requires authentication for the feature that carries the pin', async () => {
      const spec = await approvedSpec();
      const { featureId } = await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }));
      await request(app.getHttpServer()).get(`/api/v1/features/${featureId}`).expect(401);
    });
  });

  describe('atomic creation', () => {
    const noTrace = async (before: Awaited<ReturnType<typeof counts>>) => {
      expect(await counts()).toEqual(before);
    };

    it('leaves nothing behind when saving the feature fails', async () => {
      const spec = await approvedSpec();
      const before = await counts();
      const save = EntityManager.prototype.save;
      vi.spyOn(EntityManager.prototype, 'save').mockImplementation(function (this: EntityManager, ...args: any[]) {
        if (args[0] instanceof Feature) return Promise.reject(new Error('feature insert failed'));
        return (save as any).apply(this, args);
      } as never);
      await expect(app.get(FeaturePlanService).create(plan({ specId: spec.id, specApproval: spec.token }), ann)).rejects.toThrow('feature insert failed');
      vi.restoreAllMocks();
      await noTrace(before);
    });

    it('leaves nothing behind when pinning the recording fails', async () => {
      const spec = await approvedSpec();
      const before = await counts();
      vi.spyOn(SpecService.prototype, 'pinRecording').mockRejectedValue(new Error('pin failed'));
      await expect(app.get(FeaturePlanService).create(plan({ specId: spec.id, specApproval: spec.token }), ann)).rejects.toThrow('pin failed');
      vi.restoreAllMocks();
      await noTrace(before);
    });

    it('leaves nothing behind when a later job fails, after the feature, the pin and earlier jobs were written', async () => {
      const spec = await approvedSpec();
      const before = await counts();
      const create = JobService.prototype.create;
      let calls = 0;
      vi.spyOn(JobService.prototype, 'create').mockImplementation(function (this: JobService, ...args: any[]) {
        if (++calls === 2) return Promise.reject(new Error('second job failed'));
        return (create as any).apply(this, args);
      } as never);
      const result = await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }));
      expect(result).toEqual({ created: false, error: 'second job failed' });
      expect(calls).toBe(2);
      vi.restoreAllMocks();
      await noTrace(before);
    });

    it('leaves nothing behind when dependency validation of a later job fails', async () => {
      const spec = await approvedSpec();
      const before = await counts();
      const validate = JobService.prototype.validateDependencies;
      let calls = 0;
      vi.spyOn(JobService.prototype, 'validateDependencies').mockImplementation(function (this: JobService, ...args: any[]) {
        if (++calls === 2) return Promise.reject(new Error('dependency validation failed'));
        return (validate as any).apply(this, args);
      } as never);
      const result = await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }));
      expect(result).toEqual({ created: false, error: 'dependency validation failed' });
      vi.restoreAllMocks();
      await noTrace(before);
    });

    it('validates dependencies against jobs created earlier in the same uncommitted transaction', async () => {
      const spec = await approvedSpec();
      const validate = vi.spyOn(JobService.prototype, 'validateDependencies');
      const result = await exec('createPlannedFeature', plan({ specId: spec.id, specApproval: spec.token }));
      expect(result.created).toBe(true);
      const manager = validate.mock.calls.map((c) => c[3]);
      expect(manager).toHaveLength(2);
      expect(manager.every((m) => m !== undefined)).toBe(true);
      expect(new Set(manager).size).toBe(1);
    });

    it('leaves nothing behind for a plan without a spec when a job fails', async () => {
      const before = await counts();
      const create = JobService.prototype.create;
      let calls = 0;
      vi.spyOn(JobService.prototype, 'create').mockImplementation(function (this: JobService, ...args: any[]) {
        if (++calls === 2) return Promise.reject(new Error('boom'));
        return (create as any).apply(this, args);
      } as never);
      expect(await exec('createPlannedFeature', plan())).toEqual({ created: false, error: 'boom' });
      vi.restoreAllMocks();
      expect(await counts()).toEqual(before);
    });
  });
});
