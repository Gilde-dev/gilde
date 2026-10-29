import { planProblems } from './werkmeester.checks.js';
import { FETCH, planJob, validJobs } from './werkmeester.fixture.js';

const criteria = [{ id: 'AC-1' }, { id: 'AC-2' }];

describe('planProblems', () => {
    it('accepts a plan that covers every criterion, starts with the fetch line and declares its dependencies', () => {
        expect(planProblems(criteria, validJobs())).toEqual([]);
    });

    it('names a criterion no job mentions, matching whole tokens only', () => {
        const jobs = [planJob('a', { task: `${FETCH} Covers AC-1 and AC-21.` })];
        expect(planProblems(criteria, jobs)).toEqual([expect.stringContaining('AC-2 of the spec is not mentioned')]);
        expect(planProblems(criteria, [planJob('a', { task: `${FETCH} Do it.`, acceptanceCriteria: ['AC-1 and AC-2 hold'] })])).toEqual([]);
    });

    it('names a task that does not start with the fetch and rebase line', () => {
        const jobs = [planJob('a', { task: 'Do AC-1 and AC-2.' })];
        expect(planProblems(criteria, jobs)).toEqual([expect.stringContaining('Job "a": the task must start with')]);
        expect(planProblems(criteria, [planJob('a', { task: `Then ${FETCH} AC-1 AC-2` })])).toHaveLength(1);
    });

    it('names a job that mentions another job of the plan without depending on it, by title or quoted key', () => {
        const base = [planJob('api', { title: 'Build the API', task: `${FETCH} AC-1` }), planJob('web', { task: `${FETCH} AC-2` })];
        const byTitle = [base[0], { ...base[1], task: `${FETCH} AC-2. Builds on "Build the API".` }];
        expect(planProblems(criteria, byTitle)).toEqual([expect.stringContaining('Job "web" mentions job "api"')]);
        const byKey = [base[0], { ...base[1], task: `${FETCH} AC-2. Uses what \`api\` adds.` }];
        expect(planProblems(criteria, byKey)).toEqual([expect.stringContaining('Job "web" mentions job "api"')]);
    });

    it('accepts the mention when the dependency is direct or indirect, and ignores plain words and the job itself', () => {
        const a = planJob('a', { title: 'Alpha work', task: `${FETCH} AC-1` });
        const b = planJob('b', { title: 'Beta work', task: `${FETCH} AC-2`, dependsOn: ['a'] });
        const c = planJob('c', { title: 'Gamma work', task: `${FETCH} AC-2. Uses "Alpha work" and \`b\`.`, dependsOn: ['b'] });
        expect(planProblems(criteria, [a, b, c])).toEqual([]);
        const plain = planJob('web', { task: `${FETCH} AC-2. Show the api data in the web page; gamma work later.` });
        expect(planProblems(criteria, [planJob('api', { task: `${FETCH} AC-1` }), plain])).toEqual([]);
    });
});
