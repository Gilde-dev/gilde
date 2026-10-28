import { RequestContext } from '@mastra/core/request-context';
import type { DataSource } from 'typeorm';

import type { JobService } from '../job/job.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import type { SpecService } from '../spec/spec.service.js';
import { FeaturePlanService } from './feature-plan.service.js';

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
    // A fake DataSource whose manager answers the project and repo reads of the plan validation.
    const manager = {
        findOneBy: vi.fn().mockImplementation(async (entity: unknown) => (entity === Project ? { id: PROJECT } : null)),
        find: vi.fn().mockImplementation(async (entity: unknown) => (entity === Repo ? [{ id: REPO, projectId: PROJECT, defaultBranch: 'main' }] : [])),
    };
    const plans = new FeaturePlanService({ manager } as unknown as DataSource, {} as SpecService, {} as JobService);
    const s = { plans, manager };
    const tools = createCopilotTools(s as unknown as CopilotServices);
    const run = (tool: 'planFeature' | 'createPlannedFeature', input: unknown) => {
        const requestContext = new RequestContext();
        requestContext.set(COPILOT_USER_KEY, USER);
        return (tools[tool].execute as (i: unknown, c: unknown) => Promise<any>)(input, { requestContext });
    };
    return { s, tools, run };
}

const writes = (_s: ReturnType<typeof setup>['s']) => 0; // the validation only reads: the fake manager has no write methods

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

    it('names the plan job whose task and criteria are over 40000 characters together, at the boundary', async () => {
        const { run } = setup();
        const sized = (task: number, criterion: number) => ({ ...job('big'), task: 't'.repeat(task), acceptanceCriteria: ['c'.repeat(criterion)] });
        expect((await run('planFeature', draft([sized(39_997, 3)]))).valid).toBe(true);
        expect((await run('planFeature', draft([sized(39_000, 1_000)]))).valid).toBe(true);
        const over = await run('planFeature', draft([job('ok'), sized(39_000, 1_001)]));
        expect(over.valid).toBe(false);
        expect(over.problems).toEqual([expect.stringMatching(/^Job "big": the task and acceptance criteria are 40001 characters together/)]);
    });

    it('reports an unknown project', async () => {
        const { s, run } = setup();
        s.manager.findOneBy.mockResolvedValue(null);
        const result = await run('planFeature', draft());
        expect(result.valid).toBe(false);
        expect(result.problems[0]).toMatch(/Unknown project/);
    });
});

describe('createPlannedFeature', () => {
    it('requires approval before it runs', () => {
        expect(createCopilotTools({} as CopilotServices).createPlannedFeature.requireApproval).toBe(true);
    });

    it('creates through the plan service as the request-context user, ignoring any actor in the input', async () => {
        const create = vi.fn().mockResolvedValue({ created: true, featureId: 'feature-1' });
        const tools = createCopilotTools({ plans: { create } } as unknown as CopilotServices);
        const requestContext = new RequestContext();
        requestContext.set(COPILOT_USER_KEY, USER);
        const input = { ...draft(), createdBy: 'attacker', actorId: 'attacker' };
        await (tools.createPlannedFeature.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, { requestContext });
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][1]).toBe(USER);
        expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('attacker');
    });

    it('reports an error when the transaction failed, without claiming a creation', async () => {
        const create = vi.fn().mockRejectedValue(new Error('Dependency x does not exist'));
        const tools = createCopilotTools({ plans: { create } } as unknown as CopilotServices);
        const result = await (tools.createPlannedFeature.execute as (i: unknown, c: unknown) => Promise<unknown>)(draft(), { requestContext: new RequestContext() });
        expect(result).toEqual({ created: false, error: 'Dependency x does not exist' });
    });

    it('returns the problems of a plan that no longer validates', async () => {
        const create = vi.fn().mockResolvedValue({ created: false, problems: ['stale'] });
        const tools = createCopilotTools({ plans: { create } } as unknown as CopilotServices);
        const result = await (tools.createPlannedFeature.execute as (i: unknown, c: unknown) => Promise<unknown>)(draft(), { requestContext: new RequestContext() });
        expect(result).toEqual({ created: false, problems: ['stale'] });
    });
});

describe('spec-linked plan schema', () => {
    const token = { version: 2, approvalId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f' };
    it('needs specId and the approved-version token together', async () => {
        const { run } = setup();
        const onlyId = await run('planFeature', { ...draft(), specId: PROJECT });
        expect(onlyId.valid).toBe(false);
        expect(onlyId.problems.join()).toMatch(/specApproval/);
        const onlyToken = await run('planFeature', { ...draft(), specApproval: token });
        expect(onlyToken.valid).toBe(false);
    });

    it('rejects a token with extra fields or a version below 1', async () => {
        const { s } = setup();
        expect((await s.plans.validate({ ...draft(), specId: PROJECT, specApproval: { ...token, extra: 1 } })).valid).toBe(false);
        expect((await s.plans.validate({ ...draft(), specId: PROJECT, specApproval: { ...token, version: 0 } })).valid).toBe(false);
    });
});
