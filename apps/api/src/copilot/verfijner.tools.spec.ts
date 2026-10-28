import { RequestContext } from '@mastra/core/request-context';

import { createCopilotTools, type CopilotServices } from './copilot.tools.js';
import { REFINE_BINDING_KEY, issueRefineBinding, isIssuedRefineBinding, refineBinding, refineStreamOptions } from './verfijner.context.js';
import { REFINE_TOOL_NAMES, createRefineTools, type RefineServices } from './verfijner.tools.js';

const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const P2 = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const REPO1 = '11111111-1111-4111-8111-111111111111';
const REPO2 = '22222222-2222-4222-8222-222222222222';
const ITEM = '55555555-5555-4555-8555-555555555555';
const SPEC1 = '66666666-6666-4666-8666-666666666666';
const SPEC2 = '77777777-7777-4777-8777-777777777777';
const BOT = 'bot-user';

describe('Verfijner tools', () => {
    const save = vi.fn(async (_binding: unknown, _input: unknown) => ({ saved: true as const, specId: SPEC1, version: 1, created: true, status: 'draft' as const }));
    let s: ReturnType<typeof services>;

    function services() {
        return {
            specs: {
                list: vi.fn().mockResolvedValue([]),
                getDetail: vi.fn(async (id: string) => ({ id, projectId: id === SPEC1 ? P1 : P2, currentVersion: 1, approvedVersion: null, versions: [] })),
            },
            repos: { getById: vi.fn(async (id: string) => ({ id, projectId: P1, fullName: 'o/r', defaultBranch: 'main' })) },
            history: { search: vi.fn().mockResolvedValue({ status: 'ok', results: [] }) },
            github: { isConfigured: vi.fn().mockReturnValue(true), listDirectory: vi.fn().mockResolvedValue([{ path: 'a.ts', type: 'file' }]), getFileContent: vi.fn().mockResolvedValue({ content: 'x' }) },
            workspace: { ensure: vi.fn().mockResolvedValue(null) },
        };
    }

    beforeEach(() => {
        save.mockClear();
        s = services();
    });

    const tools = () => createRefineTools(s as unknown as RefineServices, { save });
    const bound = () => {
        const rc = new RequestContext();
        rc.set(REFINE_BINDING_KEY, issueRefineBinding(BOT, { id: ITEM, projectId: P1, repoId: REPO1, specId: null }, 1));
        return rc;
    };
    const run = (name: keyof ReturnType<typeof tools>, input: unknown, requestContext: RequestContext = bound()) =>
        (tools()[name].execute as (i: unknown, c: unknown) => Promise<unknown>)(input, { requestContext });

    it('exposes exactly the explicit allowlist: read tools and saveRefinedSpec', () => {
        expect(Object.keys(tools()).sort()).toEqual([...REFINE_TOOL_NAMES].sort());
        expect(Object.keys(tools()).sort()).toEqual(['getSpec', 'listRepoFiles', 'listSpecs', 'readRepoFile', 'saveRefinedSpec', 'searchHistory', 'searchRepoCode']);
    });

    it('has no approve, plan, queue, job, feature or other write tool, and no approval interrupt', () => {
        const names = Object.keys(tools());
        for (const forbidden of ['draftSpec', 'approveSpec', 'planFeature', 'createPlannedFeature', 'validateJob', 'createJob', 'suggestJob', 'listProjects', 'listRepos', 'listJobs', 'getJob', 'notificationInbox', 'getDispatchStatus']) {
            expect(names).not.toContain(forbidden);
        }
        // The co-pilot's tools are a superset the Verfijner must never inherit.
        const copilot = Object.keys(createCopilotTools({} as CopilotServices));
        expect(copilot).toContain('draftSpec');
        expect(names.filter((n) => n !== 'saveRefinedSpec' && !copilot.includes(n))).toEqual([]);
        for (const tool of Object.values(tools()) as Array<{ requireApproval?: boolean }>) expect(tool.requireApproval).toBeFalsy();
    });

    it('saveRefinedSpec takes only a title and a body; item, project, repo and spec come from the binding', async () => {
        const rc = bound();
        await run('saveRefinedSpec', { title: 'A title', body: 'text', itemId: 'other', projectId: P2, repoId: REPO2, specId: SPEC2, userId: 'x' }, rc);
        expect(save).toHaveBeenCalledTimes(1);
        const [binding, input] = save.mock.calls[0];
        expect(binding).toBe(rc.get(REFINE_BINDING_KEY));
        expect(binding).toMatchObject({ projectId: P1, repoId: REPO1, itemId: ITEM });
        expect(Object.keys(input as object).sort()).toEqual(['body', 'title']);
        const shape = (tools().saveRefinedSpec.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
        expect(Object.keys(shape ?? {}).sort()).toEqual(['body', 'title']);
    });

    it('takes the project from the binding, never from input', async () => {
        await run('listSpecs', { projectId: P2 });
        await run('searchHistory', { query: 'csv', projectId: P2, repoId: REPO2 });
        expect(s.specs.list).toHaveBeenCalledWith(P1);
        expect(s.history.search).toHaveBeenCalledWith(expect.objectContaining({ projectId: P1, query: 'csv' }));
        expect(s.history.search).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: P2 }));
    });

    it('refuses a spec of another project', async () => {
        await expect(run('getSpec', { specId: SPEC2 })).rejects.toThrow(/not in this project/);
        await expect(run('getSpec', { specId: SPEC1 })).resolves.toMatchObject({ id: SPEC1 });
    });

    it('reads code only in the bound repo, whatever repoId the model passes', async () => {
        await run('listRepoFiles', { path: '', repoId: REPO2 });
        await run('readRepoFile', { path: 'AGENTS.md', repoId: REPO2 });
        const asked = s.repos.getById.mock.calls.map((c) => c[0]);
        expect(asked).toEqual([REPO1, REPO1]);
        for (const name of ['listRepoFiles', 'readRepoFile', 'searchRepoCode'] as const) {
            const shape = (tools()[name].inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
            expect(Object.keys(shape ?? {})).not.toContain('repoId');
        }
    });

    it('does nothing without a binding issued by the server', async () => {
        const none = new RequestContext();
        const forged = new RequestContext();
        // The same shape as a real binding, but not issued by this module: what a request body or tool input could carry.
        forged.set(REFINE_BINDING_KEY, { userId: BOT, projectId: P2, repoId: REPO2, itemId: ITEM, specId: null, threadId: 't' });
        const copy = new RequestContext();
        copy.set(REFINE_BINDING_KEY, JSON.parse(JSON.stringify(issueRefineBinding(BOT, { id: ITEM, projectId: P2, repoId: REPO2, specId: null }, 1))));
        for (const rc of [none, forged, copy]) {
            expect(refineBinding(rc)).toBeNull();
            await expect(run('saveRefinedSpec', { title: 'A title', body: 'x' }, rc)).rejects.toThrow(/server-bound/);
            await expect(run('listSpecs', {}, rc)).rejects.toThrow(/server-bound/);
            await expect(run('readRepoFile', { path: 'a' }, rc)).rejects.toThrow(/server-bound/);
        }
        expect(save).not.toHaveBeenCalled();
        expect(s.specs.list).not.toHaveBeenCalled();
    });

    it('issues frozen bindings only through the server and per attempt thread', () => {
        const binding = issueRefineBinding(BOT, { id: ITEM, projectId: P1, repoId: REPO1, specId: SPEC1 }, 2);
        expect(isIssuedRefineBinding(binding)).toBe(true);
        expect(isIssuedRefineBinding({ ...binding })).toBe(false);
        expect(Object.isFrozen(binding)).toBe(true);
        expect(binding.threadId).toBe(`verfijner:${ITEM}:2`);
        const options = refineStreamOptions({ id: BOT, name: 'Verfijner', email: 'v@example.com' }, binding);
        expect(options.memory).toEqual({ resource: BOT, thread: binding.threadId });
        expect(refineBinding(options.requestContext)).toBe(binding);
    });
});
