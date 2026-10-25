import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY } from './copilot.context.js';
import { createCopilotTools, type CopilotServices } from './copilot.tools.js';

const UUID = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const OTHER = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

function setup() {
    const s = {
        jobs: { list: vi.fn().mockResolvedValue([{ id: UUID }]), getDetail: vi.fn().mockResolvedValue({ id: UUID, title: 'Job', runs: [] }) },
        features: { list: vi.fn().mockResolvedValue([]), getDetail: vi.fn().mockResolvedValue({ id: UUID, jobs: [] }) },
        revisions: { list: vi.fn().mockResolvedValue([]), listForJob: vi.fn().mockResolvedValue([{ id: OTHER }]) },
        dispatcher: { status: vi.fn().mockReturnValue({ at: null, result: null }) },
        metrics: { get: vi.fn().mockResolvedValue({ days: 30 }) },
        lessons: { list: vi.fn().mockResolvedValue([]) },
        skills: { forRepo: vi.fn().mockResolvedValue({ repoId: UUID, skills: [], counts: {} }) },
        projects: { list: vi.fn().mockResolvedValue([{ id: UUID }]) },
        repos: { listForProject: vi.fn().mockResolvedValue([{ id: OTHER }]) },
    };
    const tools = createCopilotTools(s as unknown as CopilotServices);
    const run = (tool: keyof typeof tools, input: unknown, user: { id: string } | null = null) => {
        const requestContext = new RequestContext();
        requestContext.set(COPILOT_USER_KEY, user);
        return (tools[tool].execute as (i: unknown, c: unknown) => Promise<unknown>)(input, { requestContext });
    };
    return { s, tools, run };
}

describe('co-pilot tools', () => {
    it('exposes only the read-only tools, each with a description and an input schema', () => {
        const { tools } = setup();
        expect(Object.keys(tools).sort()).toEqual([
            'getDispatchStatus', 'getFeature', 'getJob', 'getMetrics', 'getRepoSkills',
            'listFeatures', 'listJobs', 'listLessons', 'listProjects', 'listProposals', 'listRepos',
        ]);
        for (const tool of Object.values(tools)) {
            expect(tool.description.length).toBeGreaterThan(20);
            expect(tool.inputSchema).toBeDefined();
        }
    });

    it('only calls read methods of the services', async () => {
        const { s, run } = setup();
        await run('listProjects', {});
        await run('listJobs', {});
        await run('getDispatchStatus', {});
        const writes = /^(create|update|enqueue|cancel|retry|start|done|reopen|accept|reject|approve|apply|merge|pause|resume|set|toTriage|refresh|dispatch)/;
        for (const service of Object.values(s)) {
            for (const [name, fn] of Object.entries(service)) {
                if (writes.test(name)) expect(fn).not.toHaveBeenCalled();
            }
        }
    });

    it('listProjects returns the service result', async () => {
        const { run } = setup();
        expect(await run('listProjects', {})).toEqual([{ id: UUID }]);
    });

    it('listRepos lists the repos of a project', async () => {
        const { s, run } = setup();
        expect(await run('listRepos', { projectId: UUID })).toEqual([{ id: OTHER }]);
        expect(s.repos.listForProject).toHaveBeenCalledWith(UUID);
    });

    it('listJobs passes the filters and the acting user for createdBy me', async () => {
        const { s, run } = setup();
        await run('listJobs', { projectId: UUID, status: 'parked', createdBy: 'me', limit: 10 }, { id: OTHER });
        expect(s.jobs.list).toHaveBeenCalledWith({ projectId: UUID, status: 'parked', createdBy: 'me', limit: 10 }, { id: OTHER });
    });

    it('listJobs works without a user', async () => {
        const { s, run } = setup();
        await run('listJobs', { featureId: UUID, limit: 25 });
        expect(s.jobs.list).toHaveBeenCalledWith({ featureId: UUID, limit: 25 }, null);
    });

    it('listJobs rejects unknown statuses and non-uuid ids', () => {
        const { tools } = setup();
        const schema = tools.listJobs.inputSchema!;
        expect(schema.safeParse({ status: 'nope' }).success).toBe(false);
        expect(schema.safeParse({ repoId: 'not-a-uuid' }).success).toBe(false);
        expect(schema.safeParse({}).data).toEqual({ limit: 25 });
    });

    it('getJob returns the detail with its revisions', async () => {
        const { s, run } = setup();
        expect(await run('getJob', { jobId: UUID })).toEqual({ id: UUID, title: 'Job', runs: [], revisions: [{ id: OTHER }] });
        expect(s.jobs.getDetail).toHaveBeenCalledWith(UUID);
        expect(s.revisions.listForJob).toHaveBeenCalledWith(UUID);
    });

    it('listFeatures and getFeature call the feature service', async () => {
        const { s, run } = setup();
        await run('listFeatures', { projectId: UUID, status: 'active' });
        expect(s.features.list).toHaveBeenCalledWith(UUID, { status: 'active' });
        await run('getFeature', { featureId: UUID });
        expect(s.features.getDetail).toHaveBeenCalledWith(UUID);
    });

    it('listProposals defaults to proposed revisions', async () => {
        const { s, tools, run } = setup();
        await run('listProposals', tools.listProposals.inputSchema!.parse({}));
        expect(s.revisions.list).toHaveBeenCalledWith({ status: 'proposed' });
    });

    it('getDispatchStatus returns the last dispatch status', async () => {
        const { run } = setup();
        expect(await run('getDispatchStatus', {})).toEqual({ at: null, result: null });
    });

    it('getMetrics takes a window in days, 30 by default', async () => {
        const { s, tools, run } = setup();
        expect(tools.getMetrics.inputSchema!.parse({})).toEqual({ days: 30 });
        await run('getMetrics', { days: 7, projectId: UUID });
        expect(s.metrics.get).toHaveBeenCalledWith({ days: 7, projectId: UUID });
        expect(tools.getMetrics.inputSchema!.safeParse({ days: 0 }).success).toBe(false);
    });

    it('listLessons filters by status', async () => {
        const { s, run } = setup();
        await run('listLessons', { status: 'candidate' });
        expect(s.lessons.list).toHaveBeenCalledWith({ status: 'candidate' });
    });

    it('getRepoSkills returns the drift of a repo', async () => {
        const { s, run } = setup();
        expect(await run('getRepoSkills', { repoId: UUID })).toMatchObject({ repoId: UUID });
        expect(s.skills.forRepo).toHaveBeenCalledWith(UUID);
    });
});
