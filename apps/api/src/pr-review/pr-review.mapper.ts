import type { PrReview } from './pr-review.entity.js';
import type { PrReviewDto } from './pr-review.dto.js';
import { ReviewLimitsSchema, ReviewResultSchema } from './review-result.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Stored JSON is validated on the way in; a row that no longer parses is shown without it rather than failing the history. */
export function toPrReviewDto(e: PrReview, pullRequestUrl: string | null): PrReviewDto {
    const result = ReviewResultSchema.safeParse(e.result);
    const limits = ReviewLimitsSchema.safeParse(e.limits);
    return {
        id: e.id,
        jobId: e.jobId,
        prNumber: e.prNumber,
        headSha: e.headSha,
        baseSha: e.baseSha,
        baseRef: e.baseRef,
        status: e.status,
        verdict: e.verdict,
        reasonCode: e.reasonCode,
        reason: e.reason,
        result: result.success ? result.data : null,
        limits: limits.success ? limits.data : null,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        costUsd: e.costUsd,
        createdAt: e.createdAt.toISOString(),
        startedAt: iso(e.startedAt),
        completedAt: iso(e.completedAt),
        routing: { state: e.routingState, action: e.routingAction, routedAt: iso(e.routedAt) },
        override: {
            suppressed: e.suppressed,
            at: iso(e.overriddenAt),
            byUserId: e.overriddenById,
            reason: e.overrideReason,
            overriddenResult: e.overriddenResult ?? null,
        },
        links: { review: e.publicationUrl, publicationId: e.publicationId, pullRequest: pullRequestUrl },
    };
}
