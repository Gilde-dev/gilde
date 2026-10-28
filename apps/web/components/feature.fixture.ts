import { JOB_STATUSES, type Feature, type JobStatus } from '@/lib/api';

export function feature(over: Partial<Feature> = {}, merged = 1, total = 3): Feature {
  return {
    id: 'f1', projectId: 'p', title: 'Checkout flow', spec: '', acceptanceCriteria: [], pinnedSpec: null, status: 'active',
    startedAt: null, doneAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    progress: {
      total, merged, readyToClose: false, attempts: 0, leadTimeMinutes: null,
      countByStatus: Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>,
    },
    ...over,
  };
}
