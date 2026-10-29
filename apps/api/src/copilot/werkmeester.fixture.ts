export const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
export const P2 = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
export const REPO1 = '11111111-1111-4111-8111-111111111111';
export const REPO2 = '22222222-2222-4222-8222-222222222222';
export const SPEC = '66666666-6666-4666-8666-666666666666';
export const APPROVAL = '99999999-9999-4999-8999-999999999999';
export const BOT = { id: 'bot-user', name: 'Werkmeester', email: 'werkmeester@example.com' };

export const FETCH = 'First run `git fetch origin && git rebase origin/main`.';

/** The SpecService.getDetail result of an approved version 1 with two criteria. */
export function specDetail(over: Record<string, unknown> = {}, versionOver: Record<string, unknown> = {}) {
    return {
        id: SPEC, projectId: P1, repoId: REPO1, slug: 'plan-spec', archivedAt: null, currentVersion: 1, approvedVersion: 1,
        versions: [{
            id: 'v1', version: 1, title: 'Plan spec', body: '## Goal\n\nShip it.\n', bodySha256: 'sha',
            criteria: [{ number: 1, id: 'AC-1', text: 'First thing' }, { number: 2, id: 'AC-2', text: 'Second thing' }],
            approval: { id: APPROVAL }, recording: { pinnedByFeatureId: null },
            ...versionOver,
        }],
        ...over,
    };
}

export const planJob = (key: string, over: Record<string, unknown> = {}) => ({
    key, repoId: REPO1, title: `Job ${key}`, task: `${FETCH} Do ${key}.`, acceptanceCriteria: [`${key} works`], dependsOn: [] as string[], ...over,
});

/** Two jobs covering AC-1 and AC-2, the second depending on the first. */
export const validJobs = () => [
    planJob('api', { task: `${FETCH} Build the thing. Covers AC-1.` }),
    planJob('web', { task: `${FETCH} Show the thing. Covers AC-2.`, dependsOn: ['api'] }),
];
export const validPlan = () => ({ title: 'Planned feature', description: 'Build the thing.', jobs: validJobs() });
