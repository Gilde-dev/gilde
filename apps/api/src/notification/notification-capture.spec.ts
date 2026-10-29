import { NotificationCaptureService } from './notification-capture.service.js';

describe('NotificationCaptureService spec planning', () => {
    const run = { id: 'run1', projectId: 'p1' };
    const record = vi.fn(async (source: unknown) => (typeof source === 'function' ? source() : source));
    const features = { findOneBy: vi.fn() };
    const jobs = { countBy: vi.fn() };
    const capture = () => new NotificationCaptureService({ recordQuietly: record } as never, {} as never, jobs as never, features as never);

    beforeEach(() => vi.clearAllMocks());

    it('records spec.planned with the feature title, job count and one key per run', async () => {
        features.findOneBy.mockResolvedValue({ id: 'f1', title: 'Dark mode' });
        jobs.countBy.mockResolvedValue(3);
        await capture().specPlanned(run, 'f1');
        expect(await record.mock.results[0].value).toEqual({
            occurrenceKey: 'spec.planned:run1', kind: 'spec.planned', projectId: 'p1', featureId: 'f1', title: 'Dark mode', repos: [],
            reason: 'Draft feature with 3 jobs in triage; review the plan and queue the jobs', prLinks: [],
        });
    });

    it('records nothing when the feature is gone', async () => {
        features.findOneBy.mockResolvedValue(null);
        await capture().specPlanned(run, 'f1');
        expect(await record.mock.results[0].value).toBeNull();
    });

    it('records spec.plan_failed with a redacted short reason', async () => {
        await capture().specPlanFailed(run, 'Dark mode', 2, 'No plan\n Bearer abc123 gk_x_secret');
        expect(record.mock.calls[0][0]).toEqual({
            occurrenceKey: 'spec.plan_failed:run1', kind: 'spec.plan_failed', projectId: 'p1', title: 'Dark mode v2', repos: [],
            reason: 'No plan Bearer [redacted] [redacted]', prLinks: [],
        });
    });
});
