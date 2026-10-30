import { z } from 'zod';

import { PR_REVIEW_ROUTING_ACTIONS, PR_REVIEW_ROUTING_STATES, PR_REVIEW_STATUSES } from './pr-review.entity.js';
import { ReviewLimitsSchema, ReviewResultSchema } from './review-result.js';

export const PrReviewHistoryQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export type PrReviewHistoryQuery = z.infer<typeof PrReviewHistoryQuerySchema>;

export const DEFAULT_PR_REVIEW_PAGE_SIZE = 20;

export const PrReviewSchema = z.object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    prNumber: z.number().int(),
    headSha: z.string(),
    baseSha: z.string().nullable(),
    baseRef: z.string().nullable(),
    /** pending / running are in-flight; complete, incomplete, error and skipped are final. */
    status: z.enum(PR_REVIEW_STATUSES),
    /** `pass` or `blocking`; only a complete review has one. */
    verdict: z.string().nullable(),
    reasonCode: z.string().nullable(),
    reason: z.string().nullable(),
    /** Coverage, blocking findings and suggestions; null while in flight. */
    result: ReviewResultSchema.nullable(),
    limits: ReviewLimitsSchema.nullable(),
    model: z.string().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    costUsd: z.number().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    routing: z.object({
        state: z.enum(PR_REVIEW_ROUTING_STATES),
        action: z.enum(PR_REVIEW_ROUTING_ACTIONS).nullable(),
        routedAt: z.string().nullable(),
    }),
    override: z.object({
        suppressed: z.boolean(),
        at: z.string().nullable(),
        byUserId: z.string().uuid().nullable(),
        reason: z.string().nullable(),
        overriddenResult: z.record(z.string(), z.unknown()).nullable(),
    }),
    links: z.object({
        /** The GitHub review published for this head. */
        review: z.string().nullable(),
        publicationId: z.string().nullable(),
        pullRequest: z.string().nullable(),
    }),
});
export type PrReviewDto = z.infer<typeof PrReviewSchema>;

export const PrReviewPageSchema = z.object({
    items: z.array(PrReviewSchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    /** Automatic revisions queued for the job so far, over all heads. */
    revisionCount: z.number().int(),
});
export type PrReviewPageDto = z.infer<typeof PrReviewPageSchema>;
