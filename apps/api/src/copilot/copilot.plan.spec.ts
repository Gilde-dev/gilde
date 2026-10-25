import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY } from './copilot.context.js';
import { dependencyOrder, graphProblems } from './copilot.plan.js';
import { createCopilotTools, type CopilotServices } from './copilot.tools.js';

const PROJECT = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const REPO = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_REPO = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER = { id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f' };

const job = (key: string, dependsOn: string[] = [], repoId = REPO) => ({
    key,
    repoId,
    title: `Job ${key}`,
    task: `First run \`git fetch origin && git rebase origin/main\`. Do ${key}.`,
    acceptanceCriteria: [`${key} works`],
    dependsOn,
});
const draft = (jobs = [job('api'), job('web', ['api'])]) => ({
    projectId: PROJECT,
    title: 'Planned feature',
    spec: 'Build the thing.',
    acceptanceCriteria: ['The thing works'],
    jobs,
});

function setup() {
    let n = 0;
    const s = {
        projects: { getById: vi.fn().mockResolvedValue({ id: PROJECT }) },
        repos: { listForProject: vi.fn().mockResolvedValue([{ id: REPO }]) },
        features: {
            create: vi.fn().mockResolvedValue({ id: 'feature-1' }),
            cancel: vi.fn().mockResolvedValue({}),
        },
        jobs: {
            create: vi.fn().mockImplementation(async () => ({ id: `job-${++n}` })),
            cancel: vi.fn().mockResolvedValue({}),
        },
    };
    const tools = createCopilotTools(s as unknown as CopilotServices);
    const run = (tool: 'planFeature' | 'createPlannedFeature', input: unknown) => {
        const requestContext = new RequestContext();
        requestContext.set(COPILOT_USER_KEY, USER);
        return (tools[tool].execute as (i: unknown, c: unknown) => Promise<any>)(input, { requestContext });
    };
    return { s, tools, run };
}

const writes = (s: ReturnType<typeof setup>['s']) =>
    [s.features.create, s.features.cancel, s.jobs.create, s.jobs.cancel].reduce((sum, fn) => sum + fn.mock.calls.length, 0);

describe('graphProblems / dependencyOrder', () => {
    it('finds unknown keys, duplicates, self-dependencies and cycles', () => {
        expect(graphProblems([{ key: 'a', dependsOn: ['x'] }])).toEqual(['Job "a" depends on unknown key "x"']);
        expect(graphProblems([{ key: 'a', dependsOn: [] }, { key: 'a', dependsOn: [] }])).toEqual(['Duplicate job key "a"']);
        expect(graphProblems([{ key: 'a', dependsOn: ['a'] }])).toEqual(['Job "a" depends on itself']);
        expect(graphProblems([{ key: 'a', dependsOn: ['b'] }, { key: 'b', dependsOn: ['c'] }, { key: 'c', dependsOn: ['a'] }])[0]).toMatch(/^Dependency cycle: a -> b -> c -> a$/);
        expect(graphProblems([{ key: 'a', dependsOn: [] }, { key: 'b', dependsOn: ['a'] }])).toEqual([]);
    });

    it('orders dependencies first', () => {
        const ordered = dependencyOrder([{ key: 'c', dependsOn: ['b'] }, { key: 'b', dependsOn: ['a'] }, { key: 'a', dependsOn: [] }]);
        expect(ordered.map((j) => j.key)).toEqual(['a', 'b', 'c']);
    });
});

describe('planFeature', () => {
    it('returns the validated draft and writes nothing', async () => {
        const { s, run } = setup();
        const result = await run('planFeature', draft());
        expect(result.valid).toBe(true);
        expect(result.draft.jobs).toHaveLength(2);
        expect(writes(s)).toBe(0);
    });

    it('rejects a repo that is not in the project', async () => {
        const { s, run } = setup();
        const result = await run('planFeature', draft([job('api', [], OTHER_REPO)]));
        expect(result).toEqual({ valid: false, problems: [`Job "api": repo ${OTHER_REPO} is not in the project`] });
        expect(writes(s)).toBe(0);
    });

    it('rejects unknown dependency keys and cycles', async () => {
        const { s, run } = setup();
        expect((await run('planFeature', draft([job('api', ['nope'])]))).problems).toEqual(['Job "api" depends on unknown key "nope"']);
        const cyclic = await run('planFeature', draft([job('a', ['b']), job('b', ['a'])]));
        expect(cyclic.valid).toBe(false);
        expect(cyclic.problems[0]).toMatch(/Dependency cycle/);
        expect(writes(s)).toBe(0);
    });

    it('rejects titles and tasks outside the job schema limits', async () => {
        const { run } = setup();
        const result = await run('planFeature', draft([{ ...job('api'), title: 'ab', task: 'short' }]));
        expect(result.valid).toBe(false);
        expect(result.problems.join('\n')).toMatch(/jobs\.0\.title/);
        expect(result.problems.join('\n')).toMatch(/jobs\.0\.task/);
    });

    it('reports an unknown project', async () => {
        const { s, run } = setup();
        s.projects.getById.mockRejectedValue(new Error('Project not found'));
        const result = await run('planFeature', draft());
        expect(result.valid).toBe(false);
        expect(result.problems[0]).toMatch(/Unknown project/);
    });
});

describe('createPlannedFeature', () => {
    it('requires approval before it runs', () => {
        expect(createCopilotTools({} as CopilotServices).createPlannedFeature.requireApproval).toBe(true);
    });

    it('creates a draft feature and triage jobs in dependency order, mapping keys to ids, as the current user', async () => {
        const { s, run } = setup();
        const result = await run('createPlannedFeature', draft([job('web', ['api']), job('api')]));
        expect(s.features.create).toHaveBeenCalledWith(PROJECT, { title: 'Planned feature', spec: 'Build the thing.', acceptanceCriteria: ['The thing works'] });
        const [first, second] = s.jobs.create.mock.calls;
        expect(first[1]).toMatchObject({ title: 'Job api', status: 'triage', featureId: 'feature-1', dependsOn: [] });
        expect(second[1]).toMatchObject({ title: 'Job web', status: 'triage', featureId: 'feature-1', dependsOn: ['job-1'] });
        expect(first[2]).toBe(USER);
        expect(second[2]).toBe(USER);
        expect(result).toEqual({
            created: true,
            featureId: 'feature-1',
            link: '/features/feature-1',
            jobs: [{ key: 'web', jobId: 'job-2', status: 'triage' }, { key: 'api', jobId: 'job-1', status: 'triage' }],
        });
        expect(s.jobs.cancel).not.toHaveBeenCalled();
    });

    it('does not create anything for an invalid draft', async () => {
        const { s, run } = setup();
        const result = await run('createPlannedFeature', draft([job('a', ['b']), job('b', ['a'])]));
        expect(result.created).toBe(false);
        expect(writes(s)).toBe(0);
    });

    it('cancels the jobs and feature created so far when a step fails, and reports the error', async () => {
        const { s, run } = setup();
        s.jobs.create
            .mockResolvedValueOnce({ id: 'job-1' })
            .mockRejectedValueOnce(new Error('Dependency job-1 does not exist'));
        const result = await run('createPlannedFeature', draft());
        expect(s.jobs.cancel).toHaveBeenCalledTimes(1);
        expect(s.jobs.cancel).toHaveBeenCalledWith('job-1');
        expect(s.features.cancel).toHaveBeenCalledWith('feature-1');
        expect(result).toMatchObject({ created: false, error: 'Dependency job-1 does not exist', cancelledJobs: 1, cleanupFailures: [] });
    });

    it('reports what it could not clean up', async () => {
        const { s, run } = setup();
        s.jobs.create.mockResolvedValueOnce({ id: 'job-1' }).mockRejectedValueOnce(new Error('boom'));
        s.jobs.cancel.mockRejectedValue(new Error('cannot cancel'));
        const result = await run('createPlannedFeature', draft());
        expect(result.cleanupFailures).toEqual(['job job-1: cannot cancel']);
        expect(result.cancelledJobs).toBe(0);
    });
});
