import {
    ReviewLimitsSchema, ReviewResultSchema, TOO_LARGE_REASON, isActionableBlocking, isCleanReview,
} from './review-result.js';

const finding = { title: 'Missing auth', evidence: 'route X has no guard (a.ts:3)', path: 'a.ts', line: 3, impact: 'anyone can call it', requestedFix: 'add @UseGuards' };
const complete = {
    kind: 'complete', verdict: 'pass', summary: 'Looks fine', inspection: { diffComplete: true, contextComplete: true },
    coverage: [{ criterionId: 'AC-1', relevance: 'relevant', status: 'met', explanation: 'covered by a.ts' }],
    blockingFindings: [], suggestions: [{ title: 'Rename', detail: 'x is unclear' }],
};

describe('review result schemas', () => {
    it('accepts a complete pass and a complete blocking result', () => {
        const pass = ReviewResultSchema.parse(complete);
        expect(isCleanReview(pass)).toBe(true);
        expect(isActionableBlocking(pass)).toBe(false);
        const blocking = ReviewResultSchema.parse({ ...complete, verdict: 'blocking', blockingFindings: [finding] });
        expect(isCleanReview(blocking)).toBe(false);
        expect(isActionableBlocking(blocking)).toBe(true);
    });

    it('does not let an incomplete inspection validate as complete', () => {
        for (const inspection of [{ diffComplete: false, contextComplete: true }, { diffComplete: true, contextComplete: false }, undefined]) {
            expect(ReviewResultSchema.safeParse({ ...complete, inspection }).success).toBe(false);
        }
    });

    it('does not accept a verdict on incomplete, error or skipped results', () => {
        const incomplete = { kind: 'incomplete', reasonCode: 'timeout', reason: 'timed out', partialFindings: [finding], suggestions: [] };
        expect(ReviewResultSchema.safeParse(incomplete).success).toBe(true);
        expect(ReviewResultSchema.safeParse({ ...incomplete, verdict: 'pass' }).success).toBe(false);
        expect(ReviewResultSchema.safeParse({ ...incomplete, kind: 'error', reasonCode: 'execution_error' }).success).toBe(true);
        expect(ReviewResultSchema.safeParse({ kind: 'skipped', reasonCode: 'project_opt_out', reason: 'off', verdict: 'pass' }).success).toBe(false);
        // partial findings never make an incomplete result actionable
        const parsed = ReviewResultSchema.parse(incomplete);
        expect(isActionableBlocking(parsed)).toBe(false);
        expect(isCleanReview(parsed)).toBe(false);
    });

    it('fixes the reason of an oversized input to "too large"', () => {
        const tooLarge = { kind: 'incomplete', reasonCode: 'too_large', partialFindings: [], suggestions: [] };
        expect(ReviewResultSchema.safeParse({ ...tooLarge, reason: TOO_LARGE_REASON }).success).toBe(true);
        expect(ReviewResultSchema.safeParse({ ...tooLarge, reason: 'diff was big' }).success).toBe(false);
    });

    it('keeps blocking findings and suggestions apart and requires evidence, impact and a fix', () => {
        const bad = (over: object) => ReviewResultSchema.safeParse({ ...complete, verdict: 'blocking', blockingFindings: [{ ...finding, ...over }] }).success;
        expect(bad({})).toBe(true);
        expect(bad({ evidence: '' })).toBe(false);
        expect(bad({ impact: ' ' })).toBe(false);
        expect(bad({ requestedFix: undefined })).toBe(false);
        expect(bad({ path: undefined })).toBe(false); // a line needs a path
        expect(bad({ path: undefined, line: undefined })).toBe(true); // location is optional
        expect(ReviewResultSchema.safeParse({ ...complete, suggestions: [{ ...finding }] }).success).toBe(false);
    });

    it('ties the verdict to the findings', () => {
        expect(ReviewResultSchema.safeParse({ ...complete, verdict: 'pass', blockingFindings: [finding] }).success).toBe(false);
        expect(ReviewResultSchema.safeParse({ ...complete, verdict: 'blocking', blockingFindings: [] }).success).toBe(false);
    });

    it('does not let a criterion assigned elsewhere be a blocker or an unmet relevant criterion pass', () => {
        const elsewhere = { criterionId: 'AC-9', relevance: 'assigned_elsewhere', status: 'unmet', explanation: 'sibling job' };
        expect(ReviewResultSchema.safeParse({ ...complete, coverage: [...complete.coverage, elsewhere] }).success).toBe(true);
        expect(ReviewResultSchema.safeParse({
            ...complete, verdict: 'blocking', coverage: [...complete.coverage, elsewhere], blockingFindings: [{ ...finding, criterionId: 'AC-9' }],
        }).success).toBe(false);
        const unmet = { criterionId: 'AC-2', relevance: 'relevant', status: 'unmet', explanation: 'not done' };
        expect(ReviewResultSchema.safeParse({ ...complete, coverage: [unmet] }).success).toBe(false);
    });

    it('requires an explanation per criterion and a known status', () => {
        const c = (over: object) => ReviewResultSchema.safeParse({ ...complete, coverage: [{ ...complete.coverage[0], ...over }] }).success;
        expect(c({ explanation: '' })).toBe(false);
        expect(c({ status: 'maybe' })).toBe(false);
        for (const status of ['unverifiable', 'not_applicable']) expect(c({ status })).toBe(true);
    });

    it('requires finite positive integer limits', () => {
        const ok = { timeoutMs: 1000, maxSteps: 5, maxInputTokens: 1000, maxOutputTokens: 100, maxRevisions: 2 };
        expect(ReviewLimitsSchema.safeParse(ok).success).toBe(true);
        for (const bad of [0, -1, 1.5, Infinity, NaN]) expect(ReviewLimitsSchema.safeParse({ ...ok, maxSteps: bad }).success).toBe(false);
        expect(ReviewLimitsSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    });
});
