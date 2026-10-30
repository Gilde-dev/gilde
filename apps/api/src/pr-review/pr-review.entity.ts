import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { ReviewLimits, ReviewResult } from './review-result.js';

/**
 * Lifecycle of one automatic review of one PR head. `pending` is claimed but the model was never called; `running` means the
 * model execution started (and must never be repeated); the rest are final. The board status set is not touched: pending and
 * running are shown in job details only.
 */
export const PR_REVIEW_STATUSES = ['pending', 'running', 'complete', 'incomplete', 'error', 'skipped'] as const;
export type PrReviewStatus = (typeof PR_REVIEW_STATUSES)[number];
export const FINAL_PR_REVIEW_STATUSES = ['complete', 'incomplete', 'error', 'skipped'] as const;

export const PR_REVIEW_ROUTING_STATES = ['unclaimed', 'claimed', 'done'] as const;
export type PrReviewRoutingState = (typeof PR_REVIEW_ROUTING_STATES)[number];

/** What the routing owner does with the job: hand it to a human, queue a same-PR revision, or park it (revisions exhausted). */
export const PR_REVIEW_ROUTING_ACTIONS = ['human', 'revision', 'park'] as const;
export type PrReviewRoutingAction = (typeof PR_REVIEW_ROUTING_ACTIONS)[number];

/**
 * One row per job, PR and head SHA. The unique index is the durable guarantee of at most one model execution and one routing
 * action per head: claiming is inserting. Results of an old head stay as history; they never route (routing is fenced by the
 * job's current head, PR and state).
 */
@Entity({ name: 'pr_reviews' })
@Index('IDX_pr_reviews_job_pr_head', ['jobId', 'prNumber', 'headSha'], { unique: true })
@Index('IDX_pr_reviews_job_created', ['jobId', 'createdAt'])
@Index('IDX_pr_reviews_status', ['status'])
export class PrReview {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'job_id', type: 'uuid' })
    jobId: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ name: 'repo_id', type: 'uuid' })
    repoId: string;

    @Column({ name: 'pr_number', type: 'integer' })
    prNumber: number;

    @Column({ name: 'head_sha', type: 'varchar', length: 64 })
    headSha: string;

    /** The base revision the review was bound to; known once the inputs are assembled. */
    @Column({ name: 'base_sha', type: 'varchar', length: 64, nullable: true })
    baseSha: string | null;

    @Column({ name: 'base_ref', type: 'varchar', length: 255, nullable: true })
    baseRef: string | null;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: PrReviewStatus;

    /** `pass` or `blocking`; set only on a complete result. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    verdict: string | null;

    /** Machine reason of an incomplete, error or skipped result; `reason` is the human text (exactly "too large" for oversized input). */
    @Column({ name: 'reason_code', type: 'varchar', length: 32, nullable: true })
    reasonCode: string | null;

    @Column({ type: 'text', nullable: true })
    reason: string | null;

    /** The validated structured result (`review-result.ts`); null while pending or running. */
    @Column({ type: 'simple-json', nullable: true })
    result: ReviewResult | null;

    /** The limits in force when the review was claimed (`ReviewLimitsSchema`). */
    @Column({ type: 'simple-json', nullable: true })
    limits: ReviewLimits | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    model: string | null;

    @Column({ name: 'input_tokens', type: 'integer', nullable: true })
    inputTokens: number | null;

    @Column({ name: 'output_tokens', type: 'integer', nullable: true })
    outputTokens: number | null;

    @Column({ name: 'cost_usd', type: 'double precision', nullable: true })
    costUsd: number | null;

    /** Which process started the model execution; lets a restart tell its own work from an abandoned execution. Never exposed. */
    @Column({ name: 'claimed_instance', type: 'varchar', length: 64, nullable: true })
    claimedBy: string | null;

    @Column({ name: 'started_at', type: Date, nullable: true })
    startedAt: Date | null;

    @Column({ name: 'completed_at', type: Date, nullable: true })
    completedAt: Date | null;

    /** The GitHub review published for this head (GitHub's own id, so not a Gilde uuid) and its URL. */
    @Column({ name: 'publication_id', type: 'varchar', length: 64, nullable: true })
    publicationId: string | null;

    @Column({ name: 'publication_url', type: 'text', nullable: true })
    publicationUrl: string | null;

    @Column({ name: 'routing_state', type: 'varchar', length: 16, default: 'unclaimed' })
    routingState: PrReviewRoutingState;

    @Column({ name: 'routing_action', type: 'varchar', length: 16, nullable: true })
    routingAction: PrReviewRoutingAction | null;

    @Column({ name: 'routing_claimed_at', type: Date, nullable: true })
    routingClaimedAt: Date | null;

    @Column({ name: 'routed_at', type: Date, nullable: true })
    routedAt: Date | null;

    /** Head-scoped human override, reserved here and written by the override job: suppresses automatic routing for this head only. */
    @Column({ default: false })
    suppressed: boolean;

    @Column({ name: 'overridden_at', type: Date, nullable: true })
    overriddenAt: Date | null;

    @Column({ name: 'overridden_by_id', type: 'uuid', nullable: true })
    overriddenById: string | null;

    @Column({ name: 'override_reason', type: 'text', nullable: true })
    overrideReason: string | null;

    /** The automatic decision (status, verdict, routing action) that was overridden. */
    @Column({ name: 'overridden_result', type: 'simple-json', nullable: true })
    overriddenResult: Record<string, unknown> | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
