import type { PrReview, PrReviewPage, PrReviewResult } from '@/lib/api';

export function review(over: Partial<PrReview> = {}): PrReview {
  return {
    id: 'rv1', jobId: 'j1', prNumber: 5, headSha: 'abcdef1234567890', baseSha: '1111111122222222', baseRef: 'main',
    status: 'complete', verdict: 'pass', reasonCode: null, reason: null, result: null,
    limits: { timeoutMs: 120_000, maxSteps: 20, maxInputTokens: 200_000, maxOutputTokens: 8000, maxRevisions: 2 },
    model: 'openai/test', inputTokens: 1000, outputTokens: 200, costUsd: 0.01,
    createdAt: '2026-01-02T00:00:00.000Z', startedAt: null, completedAt: null,
    routing: { state: 'unclaimed', action: null, routedAt: null },
    override: { suppressed: false, at: null, byUserId: null, reason: null, overriddenResult: null },
    links: { review: 'https://github.com/o/r/pull/5#pullrequestreview-9', publicationId: '9', pullRequest: 'https://github.com/o/r/pull/5' },
    ...over,
  };
}

export const passResult: PrReviewResult = {
  kind: 'complete', verdict: 'pass', summary: 'Looks right', inspection: { diffComplete: true, contextComplete: true },
  coverage: [
    { criterionId: 'AC-1', relevance: 'relevant', status: 'met', explanation: 'Covered by the new test' },
    { criterionId: 'AC-9', relevance: 'assigned_elsewhere', status: 'unverifiable', explanation: 'Sibling job' },
  ],
  blockingFindings: [], suggestions: [{ title: 'Rename', detail: 'Consider a clearer name', path: 'src/a.ts', line: 3 }],
};

export const blockingResult: PrReviewResult = {
  kind: 'complete', verdict: 'blocking', summary: 'One defect', inspection: { diffComplete: true, contextComplete: true },
  coverage: [{ criterionId: 'AC-1', relevance: 'relevant', status: 'unmet', explanation: 'Missing' }],
  blockingFindings: [{ title: 'Null deref', evidence: 'x.y of undefined', path: 'src/b.ts', line: 9, impact: 'Crash', requestedFix: 'Guard x' }],
  suggestions: [],
};

export const page = (items: PrReview[], over: Partial<PrReviewPage> = {}): PrReviewPage => ({ items, page: 1, pageSize: 20, total: items.length, revisionCount: 0, ...over });
