import { FeaturePlanService } from './feature-plan.service.js';

const draft = (extra: Record<string, unknown> = {}) => ({
    projectId: '00000000-0000-4000-8000-000000000001', title: 'Feature', spec: 'Spec text', acceptanceCriteria: ['Works fine'],
    jobs: [{ key: 'a', repoId: '00000000-0000-4000-8000-000000000002', title: 'Job A', task: 'Do the thing.', acceptanceCriteria: ['Works fine'], dependsOn: [] }],
    ...extra,
});

describe('FeaturePlanService intake status comment hook', () => {
    const specId = '00000000-0000-4000-8000-000000000003';
    let sync: ReturnType<typeof vi.fn>;
    let withSpecLock: ReturnType<typeof vi.fn>;
    let transaction: ReturnType<typeof vi.fn>;
    let service: FeaturePlanService;

    beforeEach(() => {
        sync = vi.fn(async () => undefined);
        withSpecLock = vi.fn();
        transaction = vi.fn();
        service = new FeaturePlanService({ transaction } as never, { withSpecLock } as never, {} as never, { syncForSpec: sync } as never);
    });

    it('refreshes the comment of the spec after a plan linked to it was created', async () => {
        withSpecLock.mockResolvedValue({ created: true, featureId: 'f' });
        const result = await service.create(draft({ specId, specApproval: { version: 1, approvalId: '00000000-0000-4000-8000-000000000004' } }), null);
        expect(result.created).toBe(true);
        expect(sync).toHaveBeenCalledExactlyOnceWith(specId);
    });

    it('refreshes the comment the same way for a plan made by the Werkmeester bot', async () => {
        withSpecLock.mockResolvedValue({ created: true, featureId: 'f' });
        const result = await service.create(draft({ specId, specApproval: { version: 1, approvalId: '00000000-0000-4000-8000-000000000004' } }), { id: 'werkmeester-bot' });
        expect(result.created).toBe(true);
        expect(sync).toHaveBeenCalledExactlyOnceWith(specId);
    });

    it('does nothing for a plan without a spec', async () => {
        transaction.mockResolvedValue({ created: true, featureId: 'f' });
        await service.create(draft(), null);
        expect(sync).not.toHaveBeenCalled();
    });

    it('does nothing when the plan is invalid or the transaction fails', async () => {
        const approval = { version: 1, approvalId: '00000000-0000-4000-8000-000000000004' };
        withSpecLock.mockRejectedValueOnce(new Error('db down'));
        await expect(service.create(draft({ specId, specApproval: approval }), null)).rejects.toThrow('db down');
        expect((await service.create({ nope: true }, null)).created).toBe(false);
        expect(sync).not.toHaveBeenCalled();
    });
});
