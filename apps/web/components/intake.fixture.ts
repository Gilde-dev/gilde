import type { IntakeItem } from '@/lib/api';

export function intakeItem(over: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id: 'i1', projectId: 'p', repoId: 'r1', repoFullName: 'o/web', source: 'github_issue', externalId: '1', number: 12,
    url: 'https://github.com/o/web/issues/12', title: 'Add dark mode', authorLogin: 'ann', labels: ['gilde:refine'], status: 'new',
    specId: null, spec: null, lastError: null, refineAttempts: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}
