import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY } from './copilot.context.js';
import { createCopilotTools, type CopilotServices } from './copilot.tools.js';
import { PLAN_BINDING_KEY, issuePlanBinding, isIssuedPlanBinding, planBinding } from './werkmeester.context.js';
import { PLAN_TOOL_NAMES, createPlanTools, type PlanServices } from './werkmeester.tools.js';
import { APPROVAL, BOT, P1, P2, REPO1, REPO2, SPEC, specDetail, validPlan } from './werkmeester.fixture.js';

const OTHER_FEATURE = '88888888-8888-4888-8888-888888888888';
const target = { projectId: P1, specId: SPEC, version: 1, approvalId: APPROVAL };

describe('Werkmeester tools', () => {
    const propose = vi.fn(async (_binding: unknown, _input: unknown) => ({ created: true as const, featureId: 'f1', link: '/features/f1', jobs: [] }));
    let s: ReturnType<typeof services>;

    function services() {
        return {
            specs: {
                list: vi.fn().mockResolvedValue([]),
                getDetail: vi.fn(async (id: string) => specDetail({ id, projectId: id === SPEC ? P1 : P2 })),
            },
            repos: { getById: vi.fn(async (id: string) => ({ id, projectId: id === REPO2 ? P2 : P1, fullName: 'o/r', defaultBranch: 'main' })) },
            features: { list: vi.fn().mockResolvedValue([]), getDetail: vi.fn(async (id: string) => ({ id, projectId: id === OTHER_FEATURE ? P2 : P1, title: 'F' })) },
            jobs: { list: vi.fn().mockResolvedValue([]) },
            history: { search: vi.fn().mockResolvedValue({ status: 'ok', results: [] }) },
            github: { isConfigured: vi.fn().mockReturnValue(true), listDirectory: vi.fn().mockResolvedValue([{ path: 'a.ts', type: 'file' }]), getFileContent: vi.fn().mockResolvedValue({ content: 'x' }) },
            workspace: { ensure: vi.fn().mockResolvedValue(null) },
        };
    }

    beforeEach(() => {
        propose.mockClear();
        s = services();
    });

    const tools = () => createPlanTools(s as unknown as PlanServices, { propose });
    const bound = () => {
        const rc = new RequestContext();
        rc.set(PLAN_BINDING_KEY, issuePlanBinding(BOT.id, target, 1));
        rc.set(COPILOT_USER_KEY, BOT);
        return rc;
    };
    const run = (name: keyof ReturnType<typeof tools>, input: unknown, requestContext: RequestContext = bound()) =>
        (tools()[name].execute as (i: unknown, c: unknown) => Promise<unknown>)(input, { requestContext });

    it('exposes exactly the explicit allowlist: read tools and the single write proposePlan', () => {
        expect(Object.keys(tools()).sort()).toEqual([...PLAN_TOOL_NAMES].sort());
        expect(Object.keys(tools()).sort()).toEqual(['getFeature', 'getSpec', 'listFeatures', 'listJobs', 'listRepoFiles', 'listSpecs', 'proposePlan', 'readRepoFile', 'searchHistory', 'searchRepoCode']);
    });

    it('has no tool that queues, dispatches, approves, edits specs or changes features, and no approval interrupt', () => {
        const names = Object.keys(tools());
        for (const forbidden of ['draftSpec', 'approveSpec', 'planFeature', 'createPlannedFeature', 'createJob', 'validateJob', 'suggestJob', 'queueJob', 'dispatch', 'dispatchJobs', 'updateFeature', 'cancelFeature', 'saveRefinedSpec', 'listProjects', 'listRepos', 'getJob', 'notificationInbox', 'getDispatchStatus']) {
            expect(names).not.toContain(forbidden);
        }
        // The co-pilot's tools are a superset the Werkmeester must never inherit beyond the read ones.
        const copilot = Object.keys(createCopilotTools({} as CopilotServices));
        expect(names.filter((n) => n !== 'proposePlan' && !copilot.includes(n))).toEqual([]);
        expect(names.filter((n) => copilot.includes(n) && ['draftSpec', 'createJob', 'createPlannedFeature', 'planFeature'].includes(n))).toEqual([]);
        for (const tool of Object.values(tools())) expect((tool as { requireApproval?: boolean }).requireApproval).toBeFalsy();
    });

    it('no tool input can name a project, spec, version or approval', () => {
        const forbidden = ['projectId', 'specId', 'version', 'approvalId', 'specApproval'];
        for (const [name, tool] of Object.entries(tools())) {
            const keys = Object.keys((tool.inputSchema as unknown as { toJSONSchema?(): { properties?: object } }).toJSONSchema?.().properties ?? {});
            if (name === 'getSpec') continue; // takes a spec id, checked against the bound project below
            expect(keys.filter((k) => forbidden.includes(k)), name).toEqual([]);
        }
    });

    it('refuses to run without a server-issued binding, whatever a look-alike carries', async () => {
        const fake = new RequestContext();
        fake.set(PLAN_BINDING_KEY, { userId: BOT.id, projectId: P2, specId: SPEC, version: 1, approvalId: APPROVAL, threadId: 't' });
        expect(planBinding(fake)).toBeNull();
        expect(isIssuedPlanBinding({ ...issuePlanBinding(BOT.id, target, 1) })).toBe(false); // a copy is not the issued object
        const inputs: Record<string, unknown> = {
            getSpec: { specId: SPEC }, getFeature: { featureId: OTHER_FEATURE }, searchHistory: { query: 'x' }, proposePlan: validPlan(),
            listRepoFiles: { repoId: REPO1, path: '' }, readRepoFile: { repoId: REPO1, path: 'a.ts' }, searchRepoCode: { repoId: REPO1, query: 'x' },
        };
        for (const name of PLAN_TOOL_NAMES) await expect(run(name, inputs[name] ?? {}, fake), name).rejects.toThrow('server-bound');
        await expect(run('proposePlan', validPlan(), new RequestContext())).rejects.toThrow('server-bound');
        expect(propose).not.toHaveBeenCalled();
    });

    it('scopes the reads to the bound project', async () => {
        await run('listSpecs', {});
        expect(s.specs.list).toHaveBeenCalledWith(P1);
        await run('listFeatures', {});
        expect(s.features.list).toHaveBeenCalledWith(P1, expect.anything());
        await run('listJobs', { featureId: '8a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d' });
        expect(s.jobs.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: P1 }), expect.anything());
        await run('searchHistory', { query: 'x' });
        expect(s.history.search).toHaveBeenCalledWith(expect.objectContaining({ projectId: P1 }));
        await expect(run('getSpec', { specId: '77777777-7777-4777-8777-777777777777' })).rejects.toThrow('not in this project');
        await expect(run('getFeature', { featureId: OTHER_FEATURE })).rejects.toThrow('not in this project');
        await expect(run('listJobs', { repoId: REPO2 })).rejects.toThrow('not in this project');
        for (const name of ['listRepoFiles', 'readRepoFile', 'searchRepoCode'] as const) {
            await expect(run(name, { repoId: REPO2, path: 'a.ts', query: 'x' }), name).rejects.toThrow('not in this project');
        }
        await run('listRepoFiles', { repoId: REPO1, path: '' });
        expect(s.github.listDirectory).toHaveBeenCalled();
    });

    it('proposePlan passes the input and the issued binding to the proposer, with spec ids ignored', async () => {
        await run('proposePlan', { ...validPlan(), projectId: P2, specId: 'other', specApproval: { version: 9, approvalId: 'x' } });
        const [binding, input] = propose.mock.calls[0]!;
        expect(binding).toMatchObject(target);
        expect(isIssuedPlanBinding(binding)).toBe(true);
        expect(input).not.toHaveProperty('specId');
        expect(input).not.toHaveProperty('projectId');
    });
});
