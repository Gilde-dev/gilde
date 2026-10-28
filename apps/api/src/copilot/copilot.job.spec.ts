import { NotFoundException } from '@nestjs/common';
import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY } from './copilot.context.js';
import { COPILOT_INSTRUCTIONS } from './copilot.instructions.js';
import { createCopilotTools, type CopilotServices } from './copilot.tools.js';

const PROJECT = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const OTHER_PROJECT = 'aaaaaaaa-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const REPO = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const FEATURE = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const DEP = 'b1b1b1b1-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER = { id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f' };

const draft = (over: Record<string, unknown> = {}) => ({
    repoId: REPO,
    title: 'Add widget endpoint',
    task: 'First run `git fetch origin && git rebase origin/main`. Add the endpoint.',
    acceptanceCriteria: ['Endpoint returns 200'],
    dependsOn: [] as string[],
    ...over,
});

function setup() {
    const notFound = () => Promise.reject(new NotFoundException());
    const s = {
        repos: { getById: vi.fn(async (i: string) => (i === REPO ? { id: REPO, projectId: PROJECT, fullName: 'gilde-dev/gilde' } : notFound())) },
        features: {
            getById: vi.fn(async (i: string) => (i === FEATURE ? { id: FEATURE, projectId: PROJECT, title: 'Widgets', status: 'active' } : notFound())),
        },
        jobs: {
            getById: vi.fn(async (i: string) => (i === DEP ? { id: DEP, projectId: PROJECT, title: 'Base job' } : notFound())),
            create: vi.fn().mockResolvedValue({ id: 'job-1' }),
        },
    };
    const tools = createCopilotTools(s as unknown as CopilotServices);
    const run = (tool: 'validateJob' | 'createJob', input: unknown) => {
        const requestContext = new RequestContext();
        requestContext.set(COPILOT_USER_KEY, USER);
        return (tools[tool].execute as (i: unknown, c: unknown) => Promise<any>)(input, { requestContext });
    };
    return { s, tools, run };
}

describe('validateJob', () => {
    it('returns display fields for a valid job and creates nothing', async () => {
        const { s, run } = setup();
        const result = await run('validateJob', draft({ featureId: FEATURE, dependsOn: [DEP] }));
        expect(result).toEqual({
            valid: true,
            job: {
                repoId: REPO,
                repoFullName: 'gilde-dev/gilde',
                projectId: PROJECT,
                featureId: FEATURE,
                featureTitle: 'Widgets',
                title: 'Add widget endpoint',
                task: draft().task,
                acceptanceCriteria: ['Endpoint returns 200'],
                dependsOn: [DEP],
                dependencies: [{ id: DEP, title: 'Base job' }],
            },
        });
        expect(s.jobs.create).not.toHaveBeenCalled();
    });

    it('reports an unknown repo', async () => {
        const { run } = setup();
        const result = await run('validateJob', draft({ repoId: DEP }));
        expect(result.valid).toBe(false);
        expect(result.problems).toEqual([`Unknown repo ${DEP}`]);
    });

    it('reports a feature in another project, a closed feature and an unknown feature', async () => {
        const { s, run } = setup();
        s.features.getById.mockResolvedValueOnce({ id: FEATURE, projectId: OTHER_PROJECT, title: 'Elsewhere', status: 'active' });
        expect((await run('validateJob', draft({ featureId: FEATURE }))).problems).toEqual(['Feature "Elsewhere" is in another project than the repo']);
        s.features.getById.mockResolvedValueOnce({ id: FEATURE, projectId: PROJECT, title: 'Old', status: 'done' });
        expect((await run('validateJob', draft({ featureId: FEATURE }))).problems).toEqual(['Feature "Old" is done; pick an open feature']);
        s.features.getById.mockResolvedValueOnce({ id: FEATURE, projectId: PROJECT, title: 'Dropped', status: 'cancelled' });
        expect((await run('validateJob', draft({ featureId: FEATURE }))).problems).toEqual(['Feature "Dropped" is cancelled; pick an open feature']);
        expect((await run('validateJob', draft({ featureId: DEP }))).problems).toEqual([`Unknown feature ${DEP}`]);
    });

    it('reports an unknown and a foreign dependency', async () => {
        const { s, run } = setup();
        expect((await run('validateJob', draft({ dependsOn: [FEATURE] }))).problems).toEqual([`Unknown dependency job ${FEATURE}`]);
        s.jobs.getById.mockResolvedValueOnce({ id: DEP, projectId: OTHER_PROJECT, title: 'Foreign' });
        expect((await run('validateJob', draft({ dependsOn: [DEP] }))).problems).toEqual(['Dependency "Foreign" is in another project than the repo']);
    });

    it('reports every limit and all problems at once', async () => {
        const { run } = setup();
        const result = await run('validateJob', draft({ repoId: DEP, title: 'ab', task: 'short', acceptanceCriteria: ['x'], dependsOn: [DEP, DEP] }));
        expect(result.valid).toBe(false);
        expect(result.problems).toEqual(expect.arrayContaining([
            expect.stringContaining('title'),
            expect.stringContaining('task'),
            expect.stringContaining('acceptanceCriteria'),
            'dependsOn: duplicate dependencies',
            `Unknown repo ${DEP}`,
        ]));
        const many = await run('validateJob', draft({ acceptanceCriteria: Array(21).fill('criterion') }));
        expect(many.problems[0]).toContain('acceptanceCriteria');
        const deps = await run('validateJob', draft({ dependsOn: Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }));
        expect(deps.problems).toContain('dependsOn: at most 20 dependencies');
    });
});

describe('task and criteria size', () => {
    const sized = (task: number, ...criteria: number[]) => draft({ task: 't'.repeat(task), acceptanceCriteria: criteria.map((n) => 'c'.repeat(n)) });

    it('validateJob accepts exactly 40000 characters (criteria included) and rejects 40001', async () => {
        const { run } = setup();
        expect((await run('validateJob', sized(39_999))).valid).toBe(true);
        expect((await run('validateJob', sized(40_000))).valid).toBe(true);
        expect((await run('validateJob', sized(39_000, 500, 500))).valid).toBe(true);
        const over = await run('validateJob', sized(39_000, 500, 501));
        expect(over.valid).toBe(false);
        expect(over.problems).toEqual([expect.stringMatching(/40001 characters together.*over the 40000 limit.*shorten/)]);
        expect((await run('validateJob', sized(40_001))).valid).toBe(false);
    });

    it('createJob revalidates and writes nothing when the content is too large', async () => {
        const { s, run } = setup();
        const result = await run('createJob', sized(39_000, 500, 501));
        expect(result).toMatchObject({ created: false, problems: [expect.stringContaining('40001 characters')] });
        expect(s.jobs.create).not.toHaveBeenCalled();
        expect((await run('createJob', sized(39_000, 500, 500))).created).toBe(true);
    });
});

describe('createJob', () => {
    it('requires approval and has no status input', () => {
        const { tools } = setup();
        expect(tools.createJob.requireApproval).toBe(true);
        expect(Object.keys((tools.createJob.inputSchema as any).shape)).not.toContain('status');
    });

    it('creates exactly one triage job as the context user, with dependencies and feature', async () => {
        const { s, run } = setup();
        const result = await run('createJob', draft({ featureId: FEATURE, dependsOn: [DEP] }));
        expect(s.jobs.create).toHaveBeenCalledTimes(1);
        expect(s.jobs.create).toHaveBeenCalledWith(
            REPO,
            { title: 'Add widget endpoint', task: draft().task, acceptanceCriteria: ['Endpoint returns 200'], dependsOn: [DEP], featureId: FEATURE, status: 'triage' },
            USER,
        );
        expect(result).toEqual({ created: true, jobId: 'job-1', link: `/?project=${PROJECT}&job=job-1` });
    });

    it('re-validates and creates nothing when invalid', async () => {
        const { s, run } = setup();
        const result = await run('createJob', draft({ dependsOn: [FEATURE] }));
        expect(result).toEqual({ created: false, problems: [`Unknown dependency job ${FEATURE}`] });
        expect(s.jobs.create).not.toHaveBeenCalled();
    });
});

describe('job instructions', () => {
    it('use validateJob and createJob for single jobs and keep planFeature for several', () => {
        expect(COPILOT_INSTRUCTIONS).toContain('validateJob');
        expect(COPILOT_INSTRUCTIONS).toContain('createJob');
        expect(COPILOT_INSTRUCTIONS).toContain('Use planFeature and createPlannedFeature only for work that needs several jobs or repos');
        expect(COPILOT_INSTRUCTIONS).toContain('planFeature by about step 15');
    });
});
