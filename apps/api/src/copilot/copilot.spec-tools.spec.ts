import { BadRequestException, ConflictException } from '@nestjs/common';
import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY } from './copilot.context.js';
import { compactSpec, createCopilotTools, type CopilotServices } from './copilot.tools.js';
import { SCOUT_TOOL_NAMES } from './verkenner.tools.js';

const SPEC = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const PROJECT = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const REPO = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER = { id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f', credential: 'jwt' as const };

const detail = { id: SPEC, currentVersion: 2, status: 'draft', approvedVersion: 1 };

function setup() {
    const specs = {
        create: vi.fn().mockResolvedValue({ ...detail, currentVersion: 1, approvedVersion: null }),
        saveVersion: vi.fn().mockResolvedValue(detail),
        approve: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        getDetail: vi.fn(),
    };
    const tools = createCopilotTools({ specs } as unknown as CopilotServices);
    const run = (tool: 'draftSpec' | 'getSpec' | 'listSpecs', input: unknown, user: unknown = USER) => {
        const requestContext = new RequestContext();
        requestContext.set(COPILOT_USER_KEY, user);
        return (tools[tool].execute as (i: unknown, c: unknown) => Promise<any>)(input, { requestContext });
    };
    return { specs, tools, run };
}

const body = '## Goal\n\nx\n';

describe('draftSpec', () => {
    it('asks for confirmation before it runs', () => {
        expect(setup().tools.draftSpec.requireApproval).toBe(true);
    });

    it('creates a draft spec at expectedVersion 0 as the request-context user', async () => {
        const { specs, run } = setup();
        const result = await run('draftSpec', { projectId: PROJECT, repoId: REPO, slug: 'dark-mode', title: 'Dark mode', body, expectedVersion: 0 });
        expect(specs.create).toHaveBeenCalledWith(PROJECT, { repoId: REPO, slug: 'dark-mode', title: 'Dark mode', body, expectedVersion: 0 }, USER);
        expect(result).toMatchObject({ saved: true, specId: SPEC, approved: false, status: 'draft' });
        expect(specs.approve).not.toHaveBeenCalled();
    });

    it('saves a new version with the exact expectedVersion the model saw', async () => {
        const { specs, run } = setup();
        const result = await run('draftSpec', { specId: SPEC, title: 'Dark mode', body, expectedVersion: 1 });
        expect(specs.saveVersion).toHaveBeenCalledWith(SPEC, { title: 'Dark mode', body, expectedVersion: 1 }, USER);
        expect(result).toMatchObject({ saved: true, version: 2, status: 'draft', approved: false });
    });

    it('never trusts an actor from the input', async () => {
        const { specs, run } = setup();
        await run('draftSpec', { specId: SPEC, title: 'Dark mode', body, expectedVersion: 1, createdBy: 'x', actor: { id: 'x' } });
        expect(specs.saveVersion.mock.calls[0][2]).toBe(USER);
        expect(JSON.stringify(specs.saveVersion.mock.calls[0][1])).not.toContain('"x"');
    });

    it('writes nothing without an authenticated user', async () => {
        const { specs, run } = setup();
        const result = await run('draftSpec', { specId: SPEC, title: 'Dark mode', body, expectedVersion: 1 }, null);
        expect(result).toEqual({ saved: false, problems: ['No authenticated user'] });
        expect(specs.saveVersion).not.toHaveBeenCalled();
        expect(specs.create).not.toHaveBeenCalled();
    });

    it('refuses to create without project, repo and slug, and a new version with expectedVersion 0', async () => {
        const { specs, run } = setup();
        expect((await run('draftSpec', { title: 'Dark mode', body, expectedVersion: 0 })).saved).toBe(false);
        const stale = await run('draftSpec', { specId: SPEC, title: 'Dark mode', body, expectedVersion: 0 });
        expect(stale.saved).toBe(false);
        expect(specs.create).not.toHaveBeenCalled();
        expect(specs.saveVersion).not.toHaveBeenCalled();
    });

    it('reports a stale version or a template problem instead of throwing', async () => {
        const { specs, run } = setup();
        specs.saveVersion.mockRejectedValueOnce(new ConflictException('The spec is at version 3, not 1'));
        expect(await run('draftSpec', { specId: SPEC, title: 'Dark mode', body, expectedVersion: 1 })).toMatchObject({ saved: false, problems: ['The spec is at version 3, not 1'] });
        specs.saveVersion.mockRejectedValueOnce(new BadRequestException('The spec does not follow the template'));
        expect(await run('draftSpec', { specId: SPEC, title: 'Dark mode', body, expectedVersion: 1 })).toMatchObject({ saved: false });
    });
});

describe('spec read tools', () => {
    it('listSpecs lists by project', async () => {
        const { specs, run } = setup();
        await run('listSpecs', { projectId: PROJECT });
        expect(specs.list).toHaveBeenCalledWith(PROJECT);
    });

    it('getSpec leaves out the caller-specific approval flags and old bodies', async () => {
        const v = (version: number) => ({ version, title: 't', body: `body ${version}`, bodySha256: 'h', createdAt: 'd', criteria: [], eligibility: { eligible: true, reasons: [] }, approval: null, recording: null });
        const full = { ...detail, currentVersion: 3, approvedVersion: 2, mayApprove: true, mayApproveReasons: [], eligibility: { eligible: true, reasons: [] }, versions: [v(3), v(2), v(1)] };
        const compact = compactSpec(full as never);
        expect(compact).not.toHaveProperty('mayApprove');
        expect(compact).not.toHaveProperty('mayApproveReasons');
        expect(compact.versions.map((x) => 'body' in x)).toEqual([true, true, false]);
        const { specs, run } = setup();
        specs.getDetail.mockResolvedValue(full);
        await run('getSpec', { specId: SPEC });
        expect(specs.getDetail).toHaveBeenCalledWith(SPEC, null);
    });
});

describe('capabilities of the co-pilot and the scout', () => {
    it('has no tool that approves a spec', () => {
        const names = Object.keys(setup().tools);
        expect(names.filter((n) => /approve/i.test(n))).toEqual([]);
        const { specs, run } = setup();
        void run;
        expect(specs.approve).not.toHaveBeenCalled();
    });

    it('gives the scout exactly this allowlist, with no spec, draft or planning tool', () => {
        expect([...SCOUT_TOOL_NAMES].sort()).toEqual([
            'getFeature', 'getJob', 'listFeatures', 'listJobs', 'listLessons', 'listRepoFiles', 'listRepos', 'notificationInbox',
            'readRepoFile', 'searchHistory', 'searchRepoCode', 'suggestJob',
        ]);
        for (const forbidden of ['draftSpec', 'getSpec', 'listSpecs', 'approveSpec', 'planFeature', 'createPlannedFeature']) {
            expect(SCOUT_TOOL_NAMES).not.toContain(forbidden);
        }
    });
});
