import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  featureReplacement,
  jobReplacement,
  lessonReplacement,
  projectReplacement,
  repoReplacement,
  type Feature,
  type Job,
  type Lesson,
  type Project,
  type Repo,
} from './api';

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('returns parsed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 'p' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.listProjects()).resolves.toEqual([{ id: 'p' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/gilde/v1/projects');
  });

  it('lists specs and approves with exactly the given expectedVersion', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.listSpecs('p1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/gilde/v1/projects/p1/specs');
    await api.approveSpec('s1', 4);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/gilde/v1/specs/s1/approve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 4 });
  });

  it('throws a readable error on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Job not found' }), { status: 404 })));
    await expect(api.getJob('x')).rejects.toThrow('GET /v1/jobs/x failed: 404 Job not found');
  });
});

describe('update clients send complete PUT bodies', () => {
  const sent = async (call: () => Promise<unknown>) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await call();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, method: init.method, body: JSON.parse(String(init.body)) as Record<string, unknown>, raw: String(init.body) };
  };

  const project = {
    id: 'p1', slug: 'shop', name: 'Shop', description: null, dailyRunLimit: 20, maxAttempts: 3, runTimeoutMinutes: 60,
    retryOnChangesRequested: true, paused: true, skillsLibrary: 'repo', skillsLibraryRepoId: 'r1', dailyBudgetUsd: 0, weeklyBudgetUsd: null,
    budgetSoftPct: 80, createdAt: 'c', updatedAt: 'u',
  } as Project;
  const repo = {
    id: 'r1', projectId: 'p1', fullName: 'o/api', defaultBranch: 'main', maxConcurrentJobs: 2,
    stacks: [], testCommands: [], paused: true,
  } as unknown as Repo;
  const job = { id: 'j1', projectId: 'p1', repoId: 'r1', featureId: 'f1', title: 'T', task: 'Task', acceptanceCriteria: [], status: 'triage' } as unknown as Job;
  const feature = { id: 'f1', projectId: 'p1', title: 'F', spec: '', acceptanceCriteria: ['Done'], status: 'draft' } as unknown as Feature;
  const lesson = { id: 'l1', projectId: 'p1', text: 'L', status: 'candidate', targetKind: 'skill', targetRepoId: null, note: 'n' } as unknown as Lesson;

  it('project: every updatable field, zero and null kept, no slug, paused or timestamps', async () => {
    const r = await sent(() => api.replaceProject('p1', projectReplacement(project, { name: 'Renamed', weeklyBudgetUsd: undefined })));
    expect(r).toMatchObject({ url: '/api/gilde/v1/projects/p1', method: 'PUT' });
    expect(r.body).toEqual({
      name: 'Renamed', description: null, dailyRunLimit: 20, maxAttempts: 3, runTimeoutMinutes: 60, retryOnChangesRequested: true,
      skillsLibrary: 'repo', skillsLibraryRepoId: 'r1', dailyBudgetUsd: 0, weeklyBudgetUsd: null, budgetSoftPct: 80,
    });
  });

  it('repo: the two settings, no routine fields', async () => {
    const r = await sent(() => api.replaceRepo('r1', repoReplacement(repo, { maxConcurrentJobs: 4 })));
    expect(r).toMatchObject({ url: '/api/gilde/v1/repos/r1', method: 'PUT' });
    expect(r.body).toEqual({ defaultBranch: 'main', maxConcurrentJobs: 4 });
  });

  it('job: content and feature link; an edit can unlink with null', async () => {
    const same = await sent(() => api.replaceJob('j1', jobReplacement(job, { title: 'New' })));
    expect(same).toMatchObject({ url: '/api/gilde/v1/jobs/j1', method: 'PUT' });
    expect(same.body).toEqual({ title: 'New', task: 'Task', acceptanceCriteria: [], featureId: 'f1' });
    const unlinked = await sent(() => api.replaceJob('j1', jobReplacement(job, { featureId: null })));
    expect(unlinked.body).toMatchObject({ featureId: null });
  });

  it('feature (no editor in the UI yet): title, spec and criteria, empty values kept', async () => {
    const r = await sent(() => api.replaceFeature('f1', featureReplacement(feature, { title: 'Renamed' })));
    expect(r).toMatchObject({ url: '/api/gilde/v1/features/f1', method: 'PUT' });
    expect(r.body).toEqual({ title: 'Renamed', spec: '', acceptanceCriteria: ['Done'] });
    expect((await sent(() => api.replaceFeature('f1', featureReplacement(feature, { acceptanceCriteria: [], spec: '' })))).body).toEqual({ title: 'F', spec: '', acceptanceCriteria: [] });
  });

  it('lesson: four keys, null clears, a legacy skill kind is not sent back', async () => {
    const r = await sent(() => api.replaceLesson('l1', lessonReplacement(lesson, { note: null })));
    expect(r).toMatchObject({ url: '/api/gilde/v1/lessons/l1', method: 'PUT' });
    expect(r.body).toEqual({ text: 'L', targetKind: null, targetRepoId: null, note: null });
    expect((await sent(() => api.replaceLesson('l1', lessonReplacement(lesson, { targetKind: 'agents_md' })))).body).toMatchObject({ targetKind: 'agents_md', note: 'n' });
  });

  it('never contains undefined keys', async () => {
    const r = await sent(() => api.replaceProject('p1', projectReplacement(project, { description: undefined, budgetSoftPct: undefined })));
    expect(Object.keys(r.body)).toHaveLength(11);
    expect(r.raw).not.toContain('undefined');
  });
});
