import { z } from 'zod';

/**
 * The structured review outcome. Four kinds with different shapes, so an incomplete inspection can never validate as a clean
 * (or an actionable blocking) verdict: only `complete` has a verdict, and it must state that the whole diff and the required
 * context were inspected.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

export const CRITERION_STATUSES = ['met', 'unmet', 'unverifiable', 'not_applicable'] as const;
/** `relevant`: the criterion is this job's to deliver. `assigned_elsewhere`: feature work of a sibling job. */
export const CRITERION_RELEVANCE = ['relevant', 'assigned_elsewhere'] as const;

export const CriterionCoverageSchema = z.object({
    criterionId: text(64),
    relevance: z.enum(CRITERION_RELEVANCE),
    status: z.enum(CRITERION_STATUSES),
    explanation: text(2000),
}).strict();
export type CriterionCoverage = z.infer<typeof CriterionCoverageSchema>;

const location = {
    path: text(500).optional(),
    line: z.number().int().min(1).optional(),
};
const lineNeedsPath = (v: { path?: string; line?: number }) => v.line === undefined || v.path !== undefined;

/** A defect backed by evidence; the only thing that can send a job back. */
export const BlockingFindingSchema = z.object({
    title: text(200),
    evidence: text(4000),
    ...location,
    impact: text(2000),
    requestedFix: text(2000),
    /** The criterion it violates, when it is one. A criterion assigned elsewhere cannot be the basis of a blocker. */
    criterionId: text(64).optional(),
}).strict().refine(lineNeedsPath, { message: 'line needs a path', path: ['line'] });
export type BlockingFinding = z.infer<typeof BlockingFindingSchema>;

/** Non-blocking advice; never routes. */
export const SuggestionSchema = z.object({
    title: text(200),
    detail: text(2000),
    ...location,
}).strict().refine(lineNeedsPath, { message: 'line needs a path', path: ['line'] });
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const COMPLETE_VERDICTS = ['pass', 'blocking'] as const;

export const CompleteReviewSchema = z.object({
    kind: z.literal('complete'),
    verdict: z.enum(COMPLETE_VERDICTS),
    summary: text(4000),
    /** Literal true: a review that did not see the whole diff and the required context is not complete. */
    inspection: z.object({ diffComplete: z.literal(true), contextComplete: z.literal(true) }).strict(),
    coverage: z.array(CriterionCoverageSchema).max(200),
    blockingFindings: z.array(BlockingFindingSchema).max(50),
    suggestions: z.array(SuggestionSchema).max(100),
}).strict().superRefine((r, ctx) => {
    if (r.verdict === 'pass' && r.blockingFindings.length > 0) ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'a pass cannot have blocking findings' });
    if (r.verdict === 'blocking' && r.blockingFindings.length === 0) ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'blocking needs at least one blocking finding' });
    const elsewhere = new Set(r.coverage.filter((c) => c.relevance === 'assigned_elsewhere').map((c) => c.criterionId));
    r.blockingFindings.forEach((f, i) => {
        if (f.criterionId && elsewhere.has(f.criterionId)) {
            ctx.addIssue({ code: 'custom', path: ['blockingFindings', i, 'criterionId'], message: 'a criterion assigned to another job cannot be a blocker' });
        }
    });
    if (r.verdict === 'pass') {
        const unmet = r.coverage.filter((c) => c.relevance === 'relevant' && c.status === 'unmet');
        if (unmet.length > 0) ctx.addIssue({ code: 'custom', path: ['coverage'], message: 'a pass cannot leave a relevant criterion unmet' });
    }
});
export type CompleteReview = z.infer<typeof CompleteReviewSchema>;

/** Why an inspection could not be completed. The text of `too_large` is fixed by the spec. */
export const INCOMPLETE_REASON_CODES = [
    'too_large', 'timeout', 'step_limit', 'token_limit', 'malformed_output', 'context_unavailable', 'context_truncated',
    'budget_refused', 'budget_unavailable', 'abandoned',
] as const;
export const TOO_LARGE_REASON = 'too large';

export const IncompleteReviewSchema = z.object({
    kind: z.literal('incomplete'),
    reasonCode: z.enum(INCOMPLETE_REASON_CODES),
    reason: text(1000),
    /** Findings found before the inspection stopped. Kept for people; they never route. */
    partialFindings: z.array(BlockingFindingSchema).max(50),
    suggestions: z.array(SuggestionSchema).max(100),
}).strict().superRefine((r, ctx) => {
    if (r.reasonCode === 'too_large' && r.reason !== TOO_LARGE_REASON) ctx.addIssue({ code: 'custom', path: ['reason'], message: `the reason of a too_large result is exactly "${TOO_LARGE_REASON}"` });
});
export type IncompleteReview = z.infer<typeof IncompleteReviewSchema>;

export const ERROR_REASON_CODES = ['execution_error', 'publication_failed', 'recovery_error'] as const;
export const ErrorReviewSchema = z.object({
    kind: z.literal('error'),
    reasonCode: z.enum(ERROR_REASON_CODES),
    reason: text(1000),
    partialFindings: z.array(BlockingFindingSchema).max(50),
    suggestions: z.array(SuggestionSchema).max(100),
}).strict();
export type ErrorReview = z.infer<typeof ErrorReviewSchema>;

export const SKIP_REASON_CODES = ['project_opt_out', 'runtime_disabled', 'runtime_unconfigured', 'kill_switch', 'superseded'] as const;
export const SkippedReviewSchema = z.object({
    kind: z.literal('skipped'),
    reasonCode: z.enum(SKIP_REASON_CODES),
    reason: text(1000),
}).strict();
export type SkippedReview = z.infer<typeof SkippedReviewSchema>;

export const ReviewResultSchema = z.discriminatedUnion('kind', [CompleteReviewSchema, IncompleteReviewSchema, ErrorReviewSchema, SkippedReviewSchema]);
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** Only a complete result with a pass is a clean review. */
export function isCleanReview(result: ReviewResult): boolean {
    return result.kind === 'complete' && result.verdict === 'pass';
}

/** Only a complete blocking result may send a job back for a revision; everything else goes to a human. */
export function isActionableBlocking(result: ReviewResult): boolean {
    return result.kind === 'complete' && result.verdict === 'blocking' && result.blockingFindings.length > 0;
}

const positiveInt = z.number().int().min(1).max(2_000_000_000);

/** The limits a review runs under, snapshotted on the review row. All finite and positive. */
export const ReviewLimitsSchema = z.object({
    timeoutMs: positiveInt,
    maxSteps: positiveInt,
    maxInputTokens: positiveInt,
    maxOutputTokens: positiveInt,
    maxRevisions: positiveInt,
}).strict();
export type ReviewLimits = z.infer<typeof ReviewLimitsSchema>;

export const DEFAULT_MAX_REVISIONS = 2;
