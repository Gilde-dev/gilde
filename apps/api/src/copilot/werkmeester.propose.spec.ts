import { issuePlanBinding, planOutcome } from './werkmeester.context.js';
import { PlanProposer } from './werkmeester.propose.js';
import { APPROVAL, BOT, FETCH, P1, REPO1, SPEC, planJob, specDetail, validJobs, validPlan } from './werkmeester.fixture.js';
import { ConflictException } from '@nestjs/common';

const target = { projectId: P1, specId: SPEC, version: 1, approvalId: APPROVAL };

describe('PlanProposer', () => {
    const getDetail = vi.fn();
    const create = vi.fn();
    const proposer = new PlanProposer({ getDetail }, { create });
    const bind = () => issuePlanBinding(BOT.id, target, 1);

    beforeEach(() => {
        vi.resetAllMocks();
        getDetail.mockResolvedValue(specDetail());
        create.mockResolvedValue({ created: true, featureId: 'f1', link: '/features/f1', jobs: [{ key: 'api', jobId: 'j1', status: 'triage' }], spec: null });
    });

    it('creates the plan through FeaturePlanService with the bound spec, version and approval, as the bot', async () => {
        const binding = bind();
        const result = await proposer.propose(binding, validPlan());
        expect(result).toMatchObject({ created: true, featureId: 'f1' });
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                projectId: P1, specId: SPEC, specApproval: { version: 1, approvalId: APPROVAL }, title: 'Planned feature', spec: 'Build the thing.',
                acceptanceCriteria: ['AC-1: First thing', 'AC-2: Second thing'],
            }),
            { id: BOT.id },
        );
        expect(planOutcome(binding).featureId).toBe('f1');
        // A second call in the same run is refused instead of creating a second feature.
        expect(await proposer.propose(binding, validPlan())).toMatchObject({ created: false, retryable: false });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('cannot be steered to another spec by extra input fields', async () => {
        await proposer.propose(bind(), { ...validPlan(), projectId: 'x', specId: 'y', specApproval: { version: 7, approvalId: 'z' } } as never);
        expect(create.mock.calls[0]![0]).toMatchObject({ projectId: P1, specId: SPEC, specApproval: { version: 1, approvalId: APPROVAL } });
    });

    it('returns fixable errors before creating: an uncovered criterion, a missing fetch line, an undeclared dependency', async () => {
        const uncovered = await proposer.propose(bind(), { ...validPlan(), jobs: [validJobs()[0]!] });
        expect(uncovered).toMatchObject({ created: false, retryable: true, errors: [expect.stringContaining('AC-2')] });

        const noFetch = await proposer.propose(bind(), { ...validPlan(), jobs: [planJob('api', { task: 'Covers AC-1 AC-2' })] });
        expect(noFetch).toMatchObject({ created: false, retryable: true, errors: [expect.stringContaining('must start with')] });

        const jobs = [planJob('api', { title: 'Build the API', task: `${FETCH} AC-1` }), planJob('web', { task: `${FETCH} AC-2, on top of "Build the API"` })];
        const undeclared = await proposer.propose(bind(), { ...validPlan(), jobs });
        expect(undeclared).toMatchObject({ created: false, retryable: true, errors: [expect.stringContaining('does not list it in dependsOn')] });
        expect(create).not.toHaveBeenCalled();
    });

    it('lets the agent fix the errors and succeed within one run', async () => {
        const binding = bind();
        expect(await proposer.propose(binding, { ...validPlan(), jobs: [validJobs()[0]!] })).toMatchObject({ retryable: true });
        expect(planOutcome(binding).lastProblems).toHaveLength(1);
        expect(await proposer.propose(binding, validPlan())).toMatchObject({ created: true });
    });

    it('relays the problems of FeaturePlanService as fixable errors', async () => {
        create.mockResolvedValue({ created: false, problems: ['Job "api": repo x is not in the project'] });
        expect(await proposer.propose(bind(), validPlan())).toEqual({ created: false, retryable: true, errors: ['Job "api": repo x is not in the project'] });
    });

    it('refuses without retry when the version already has a pinned feature', async () => {
        getDetail.mockResolvedValue(specDetail({}, { recording: { pinnedByFeatureId: 'f0' } }));
        const binding = bind();
        expect(await proposer.propose(binding, validPlan())).toEqual({ created: false, retryable: false, reason: expect.stringContaining('already has a feature pinned') });
        expect(planOutcome(binding).skipReason).toContain('already has a feature');
        expect(create).not.toHaveBeenCalled();
    });

    it.each([
        ['archived', { archivedAt: '2026-01-01T00:00:00.000Z' }, {}, 'archived'],
        ['superseded by a newer approved version', { approvedVersion: 2 }, {}, 'no longer the approved version'],
        ['approved again by another approval', {}, { approval: { id: 'other' } }, 'another approval'],
    ])('refuses without retry when the spec is %s', async (_name, detail, version, reason) => {
        getDetail.mockResolvedValue(specDetail(detail, version));
        expect(await proposer.propose(bind(), validPlan())).toMatchObject({ created: false, retryable: false, reason: expect.stringContaining(reason) });
    });

    it('treats a feature that pinned the version during creation as not retryable', async () => {
        getDetail.mockResolvedValueOnce(specDetail()).mockResolvedValueOnce(specDetail()).mockResolvedValue(specDetail({}, { recording: { pinnedByFeatureId: 'f9' } }));
        create.mockRejectedValue(new ConflictException('This recording is already pinned by another feature'));
        expect(await proposer.propose(bind(), validPlan())).toMatchObject({ created: false, retryable: false });
    });
});
