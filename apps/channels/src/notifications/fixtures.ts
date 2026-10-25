import type { GildeNotification } from './types.js';

export function notification(overrides: Partial<GildeNotification> = {}): GildeNotification {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    occurrenceKey: 'k1',
    kind: 'job.awaiting_review',
    occurredAt: '2026-01-01T00:00:00.000Z',
    projectId: 'p1',
    jobId: 'j1',
    featureId: null,
    title: 'Add thing',
    repos: ['gilde-dev/gilde'],
    reason: 'CI passed',
    prLinks: [{ repo: 'gilde-dev/gilde', number: 5, url: 'https://github.com/gilde-dev/gilde/pull/5' }],
    status: 'pending',
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    deliveredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
