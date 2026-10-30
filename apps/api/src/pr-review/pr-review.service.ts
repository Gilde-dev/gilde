import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';

import { Job } from '../job/job.entity.js';
import { KeyedMutex } from '../spec/keyed-mutex.js';
import { nextStatus, type JobStatus } from '../job/job-state.js';

import { DEFAULT_PR_REVIEW_PAGE_SIZE, type PrReviewHistoryQuery, type PrReviewPageDto } from './pr-review.dto.js';
import { toPrReviewDto } from './pr-review.mapper.js';
import { PrReview, FINAL_PR_REVIEW_STATUSES, type PrReviewRoutingAction } from './pr-review.entity.js';
import {
    DEFAULT_MAX_REVISIONS, ReviewLimitsSchema, ReviewResultSchema,
    type ReviewLimits, type ReviewResult, type SkippedReview,
} from './review-result.js';

/** A review is claimed, run and routed while the job waits in pr_open for its gate; any other state means it moved on. */
export const REVIEW_FENCE_STATUSES: JobStatus[] = ['pr_open'];

/** Extra time a running review gets beyond its own timeout before the sweep calls it abandoned. */
export const ABANDONED_GRACE_MS = 2 * 60_000;
const FALLBACK_TIMEOUT_MS = 10 * 60_000;
const ABANDONED_REASON = 'The review execution was interrupted before it finished and is not repeated';

export interface ReviewTarget {
    jobId: string;
    prNumber: number;
    headSha: string;
}

export interface ClaimInput extends ReviewTarget {
    limits: ReviewLimits;
    baseSha?: string | null;
    baseRef?: string | null;
}

export interface Usage {
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
}

export type ClaimResult =
    | { claimed: true; review: PrReview }
    /** `review` is the existing row of this head, or null when the job/PR/head is no longer current. */
    | { claimed: false; review: PrReview | null; reason: 'exists' | 'stale' };

export type RoutingClaim =
    | { claimed: true }
    | { claimed: false; reason: 'stale' | 'already_claimed' | 'not_actionable' | 'revisions_exhausted' };

/** What `applyRouting` does to the job together with the review's one routing claim. */
export type RoutingPlan =
    | { action: 'human' }
    | { action: 'revision'; reason: string; maxAttempts: number }
    | { action: 'park'; reason: string };

export type AppliedRouting =
    | { applied: true; job: Job }
    | { applied: false; reason: 'stale' | 'already_routed' | 'not_actionable' | 'revisions_exhausted' | 'attempts_exhausted' };

/** Thrown inside a transaction to roll it back when a later conditional write loses. */
class RollbackSignal extends Error {
    constructor(readonly outcome: RoutingClaim) { super('rollback'); }
}

class RollbackApply extends Error {
    constructor(readonly outcome: AppliedRouting) { super('rollback'); }
}

class RollbackOverride extends Error {
    constructor() { super('rollback'); }
}

/** Which automatic decision state a human override acts on; each has its own job status and routing provenance. */
export type OverrideKind = 'review_pending' | 'auto_parked' | 'auto_revision_queued';

export interface OverrideInput {
    kind: OverrideKind;
    reviewId: string;
    actorId: string;
    reason: string;
}

export type AppliedOverride =
    | { applied: true; job: Job; review: PrReview }
    /** The review or the job changed since it was read (routed, dispatched, new head, ...): nothing was written. */
    | { applied: false };

const OVERRIDE_FROM: Record<OverrideKind, JobStatus> = { review_pending: 'pr_open', auto_parked: 'parked', auto_revision_queued: 'queued' };

/**
 * The durable review ledger. Every state change is a conditional write, so concurrent observations, a restarted process and a
 * moved-on job all resolve in the database, never in process memory. Methods returning entities are internal (the worker and
 * routing code); `listForJob` returns DTOs.
 *
 * Routing fence: an automatic review may be claimed, started and routed only while the job still has the PR number and head
 * SHA the review is bound to and is in `REVIEW_FENCE_STATUSES`. A completed result of an old head is kept as history only.
 */
@Injectable()
export class PrReviewService implements OnApplicationBootstrap {
    private readonly logger = new Logger(PrReviewService.name);
    /** Identifies this process in `claimed_by`, so a restart can tell its own executions from abandoned ones. */
    readonly instanceId = randomUUID();

    constructor(
        @InjectRepository(PrReview) private readonly reviews: Repository<PrReview>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        private readonly dataSource: DataSource,
    ) { }

    async onApplicationBootstrap(): Promise<void> {
        try {
            await this.recoverOnStartup();
        } catch (e) {
            this.logger.error(`Review recovery failed: ${(e as Error).message}`);
        }
    }

    /**
     * Claims the single review of this job, PR and head by inserting its row. Exactly one concurrent caller gets `claimed: true`
     * and with it the right to start the model execution; the others see `exists`. Locks the job row first, so a head change
     * cannot slip in between the check and the insert.
     */
    claimExecution(input: ClaimInput): Promise<ClaimResult> {
        return this.insertFenced(input, (id, job) => this.reviews.create({
            id, ...base(input, job), status: 'pending', limits: ReviewLimitsSchema.parse(input.limits),
        }));
    }

    /** Records that the review was skipped (opted out, runtime off, ...) for this head, once. Not a model execution. */
    recordSkip(input: ReviewTarget & { baseSha?: string | null; baseRef?: string | null; limits?: ReviewLimits | null }, skipped: SkippedReview): Promise<ClaimResult> {
        const result = ReviewResultSchema.parse(skipped);
        return this.insertFenced(input, (id, job) => this.reviews.create({
            id, ...base(input, job), status: 'skipped', limits: input.limits ?? null, result,
            reasonCode: skipped.reasonCode, reason: skipped.reason, completedAt: new Date(),
        }));
    }

    private transaction<T>(work: (m: EntityManager) => Promise<T>): Promise<T> {
        const run = () => this.dataSource.transaction(work);
        return this.dataSource.options.type === 'postgres' ? run() : sqliteMutexFor(this.dataSource).run('tx', run);
    }

    private async insertFenced(target: ReviewTarget, build: (id: string, job: Job) => PrReview): Promise<ClaimResult> {
        return this.transaction(async (m) => {
            const locked = await m.createQueryBuilder().update(Job)
                .set({ headSha: () => 'head_sha' })
                .where('id = :id AND head_sha = :head AND pr_number = :pr AND status IN (:...st)', {
                    id: target.jobId, head: target.headSha, pr: target.prNumber, st: REVIEW_FENCE_STATUSES,
                }).execute();
            if (!locked.affected) return { claimed: false, review: await this.find(target, m.getRepository(PrReview)), reason: 'stale' };
            const job = await m.getRepository(Job).findOneByOrFail({ id: target.jobId });
            const row = build(randomUUID(), job);
            // ON CONFLICT DO NOTHING: a violation would abort the surrounding Postgres transaction.
            await m.createQueryBuilder().insert().into(PrReview).values(row as QueryDeepPartialEntity<PrReview>).orIgnore().execute();
            const stored = await this.find(target, m.getRepository(PrReview));
            return stored && stored.id === row.id
                ? { claimed: true, review: stored }
                : { claimed: false, review: stored, reason: 'exists' };
        });
    }

    /**
     * pending → running: the last step before the model call. Exactly one caller wins it, and only while the job is still on
     * this head; the winner owns the execution and it is never started again. Returns false when it was already started, or
     * when the job moved on (the row then stays pending until `recoverOnStartup`/`sweep` supersede it).
     */
    async markRunning(reviewId: string): Promise<boolean> {
        const res = await this.reviews.createQueryBuilder().update(PrReview)
            .set({ status: 'running', startedAt: new Date(), claimedBy: this.instanceId })
            .where(`id = :id AND status = 'pending' AND ${FENCE}`, { id: reviewId, st: REVIEW_FENCE_STATUSES })
            .execute();
        return !!res.affected;
    }

    /**
     * Stores the validated result and usage. Allowed from `running`, and from `pending` for results that need no model call
     * (preflight "too large", skips). Returns null when the review was already final: the first result wins. The result is
     * kept even when the job has moved on; only routing is fenced.
     */
    async complete(reviewId: string, result: ReviewResult, usage: Usage = {}): Promise<PrReview | null> {
        const parsed = ReviewResultSchema.parse(result);
        const res = await this.reviews.createQueryBuilder().update(PrReview)
            .set({
                status: parsed.kind,
                verdict: parsed.kind === 'complete' ? parsed.verdict : null,
                reasonCode: parsed.kind === 'complete' ? null : parsed.reasonCode,
                reason: parsed.kind === 'complete' ? null : parsed.reason,
                result: parsed,
                model: usage.model ?? null,
                inputTokens: usage.inputTokens ?? null,
                outputTokens: usage.outputTokens ?? null,
                costUsd: usage.costUsd ?? null,
                completedAt: new Date(),
            })
            .where(`id = :id AND status IN ('pending', 'running')`, { id: reviewId })
            .execute();
        return res.affected ? this.reviews.findOneByOrFail({ id: reviewId }) : null;
    }

    /** Stores the GitHub review reference, once. Returns false when one is already stored. */
    async recordPublication(reviewId: string, publication: { id: string; url: string }): Promise<boolean> {
        const res = await this.reviews.createQueryBuilder().update(PrReview)
            .set({ publicationId: publication.id, publicationUrl: publication.url })
            .where('id = :id AND publication_id IS NULL', { id: reviewId })
            .execute();
        return !!res.affected;
    }

    /**
     * Claims the one routing action of a final review. Exactly one caller wins, only while the job still has this PR and head
     * and is in a fenced state, and never for a suppressed (overridden) head.
     *
     * `revision` also needs a complete blocking result and, in the same transaction, takes one of the job's revisions: the
     * count is incremented only below the review's `maxRevisions`, and the job records which review the pending revision
     * carries. When the revision limit is reached nothing is claimed (`revisions_exhausted`), so the caller can claim `park`.
     */
    async claimRouting(reviewId: string, action: PrReviewRoutingAction): Promise<RoutingClaim> {
        const review = await this.reviews.findOneBy({ id: reviewId });
        if (!review) return { claimed: false, reason: 'stale' };
        const maxRevisions = ReviewLimitsSchema.safeParse(review.limits).data?.maxRevisions ?? DEFAULT_MAX_REVISIONS;
        try {
            return await this.transaction(async (m) => {
                if (action === 'revision') {
                    const bumped = await m.createQueryBuilder().update(Job)
                        .set({ autoReviewRevisions: () => 'auto_review_revisions + 1', autoRevisionReviewId: review.id })
                        .where('id = :id AND head_sha = :head AND pr_number = :pr AND status IN (:...st) AND auto_review_revisions < :max', {
                            id: review.jobId, head: review.headSha, pr: review.prNumber, st: REVIEW_FENCE_STATUSES, max: maxRevisions,
                        }).execute();
                    if (!bumped.affected) {
                        const job = await m.getRepository(Job).findOneBy({ id: review.jobId });
                        const current = !!job && job.headSha === review.headSha && job.prNumber === review.prNumber && REVIEW_FENCE_STATUSES.includes(job.status);
                        throw new RollbackSignal({ claimed: false, reason: current ? 'revisions_exhausted' : 'stale' });
                    }
                }
                const actionable = action === 'revision' ? `AND status = 'complete' AND verdict = 'blocking'` : '';
                const res = await m.createQueryBuilder().update(PrReview)
                    .set({ routingState: 'claimed', routingAction: action, routingClaimedAt: new Date() })
                    .where(`id = :id AND routing_state = 'unclaimed' AND suppressed = :no AND status IN ('complete', 'incomplete', 'error', 'skipped') ${actionable} AND ${FENCE}`, {
                        id: reviewId, no: false, st: REVIEW_FENCE_STATUSES,
                    }).execute();
                if (!res.affected) throw new RollbackSignal({ claimed: false, reason: await this.whyNotRoutable(m.getRepository(PrReview), reviewId, action) });
                return { claimed: true } as const;
            });
        } catch (e) {
            if (e instanceof RollbackSignal) return e.outcome;
            throw e;
        }
    }

    private async whyNotRoutable(repo: Repository<PrReview>, reviewId: string, action: PrReviewRoutingAction): Promise<'stale' | 'already_claimed' | 'not_actionable'> {
        const r = await repo.findOneBy({ id: reviewId });
        if (!r) return 'stale';
        if (r.routingState !== 'unclaimed') return 'already_claimed';
        if (action === 'revision' && !(r.status === 'complete' && r.verdict === 'blocking')) return 'not_actionable';
        return 'stale';
    }

    /**
     * The routing action and the job's state change in one transaction, fenced by the review's head, PR and the job's state:
     * the job moves out of pr_open and the review's routing becomes `done` together, or neither happens. A revision also
     * takes one of the job's revisions and needs an attempt left (`maxAttempts`); a limit that is reached applies nothing
     * (`revisions_exhausted` / `attempts_exhausted`) so the caller can apply `park` instead.
     */
    async applyRouting(reviewId: string, plan: RoutingPlan): Promise<AppliedRouting> {
        const review = await this.reviews.findOneBy({ id: reviewId });
        if (!review) return { applied: false, reason: 'stale' };
        const maxRevisions = ReviewLimitsSchema.safeParse(review.limits).data?.maxRevisions ?? DEFAULT_MAX_REVISIONS;
        const event = plan.action === 'human' ? 'ci_passed' : plan.action === 'revision' ? 'retry' : 'park';
        const to = nextStatus('pr_open', event)!;
        const now = new Date();
        const changes: QueryDeepPartialEntity<Job> = { status: to };
        if (plan.action === 'revision') {
            Object.assign(changes, {
                lastReason: plan.reason, queuedAt: now, nextRoundKind: null,
                autoReviewRevisions: () => 'auto_review_revisions + 1', autoRevisionReviewId: review.id,
            });
        }
        if (plan.action === 'park') Object.assign(changes, { lastReason: plan.reason });
        try {
            return await this.transaction(async (m) => {
                // The review's claim goes first: its fence reads the job as it still is.
                const actionable = plan.action === 'revision' ? `AND status = 'complete' AND verdict = 'blocking'` : '';
                const claimed = await m.createQueryBuilder().update(PrReview)
                    .set({ routingState: 'done', routingAction: plan.action, routingClaimedAt: now, routedAt: now })
                    .where(`id = :id AND routing_state = 'unclaimed' AND suppressed = :no AND status IN (:...fin) ${actionable} AND ${FENCE}`, {
                        id: reviewId, no: false, fin: FINAL_PR_REVIEW_STATUSES, st: REVIEW_FENCE_STATUSES,
                    }).execute();
                if (!claimed.affected) {
                    const r = await m.getRepository(PrReview).findOneBy({ id: reviewId });
                    const reason = !r ? 'stale' : r.routingState !== 'unclaimed' ? 'already_routed'
                        : plan.action === 'revision' && !(r.status === 'complete' && r.verdict === 'blocking') ? 'not_actionable' : 'stale';
                    throw new RollbackApply({ applied: false, reason });
                }
                const query = m.createQueryBuilder().update(Job).set(changes)
                    .where('id = :id AND head_sha = :head AND pr_number = :pr AND status IN (:...st)', {
                        id: review.jobId, head: review.headSha, pr: review.prNumber, st: REVIEW_FENCE_STATUSES,
                    });
                if (plan.action === 'revision') {
                    query.andWhere('auto_review_revisions < :maxRev AND attempts < :maxAttempts', { maxRev: maxRevisions, maxAttempts: plan.maxAttempts });
                }
                const moved = await query.execute();
                if (!moved.affected) {
                    const job = await m.getRepository(Job).findOneBy({ id: review.jobId });
                    const current = !!job && job.headSha === review.headSha && job.prNumber === review.prNumber && REVIEW_FENCE_STATUSES.includes(job.status);
                    if (current && plan.action === 'revision') {
                        throw new RollbackApply({ applied: false, reason: job.autoReviewRevisions >= maxRevisions ? 'revisions_exhausted' : 'attempts_exhausted' });
                    }
                    throw new RollbackApply({ applied: false, reason: 'stale' });
                }
                return { applied: true, job: await m.getRepository(Job).findOneByOrFail({ id: review.jobId }) } as const;
            });
        } catch (e) {
            if (e instanceof RollbackApply) return e.outcome;
            throw e;
        }
    }

    /**
     * The audited human override of one automatic decision, as one compare-and-set over the review row and the job row in a
     * transaction. The review is suppressed (head-bound: a new head has its own row) only while its routing is still in the
     * state the kind needs, and the job moves to awaiting_review only while it still has this PR and head, the status the
     * kind needs and, for a pending automatic revision, that revision's provenance. The review's routing claim, the
     * dispatcher's queued claim (which clears the provenance) and this write all fence each other on those rows, so
     * whichever wins excludes the others. Protected-path approval flags are not touched; running work is never cancelled
     * (a dispatched job has the wrong status and the write loses).
     */
    async applyOverride(input: OverrideInput): Promise<AppliedOverride> {
        const review = await this.reviews.findOneBy({ id: input.reviewId });
        if (!review) return { applied: false };
        const from = OVERRIDE_FROM[input.kind];
        const to = nextStatus(from, 'review_override')!;
        const now = new Date();
        const routing = input.kind === 'review_pending'
            ? `routing_state = 'unclaimed'`
            : `routing_state = 'done' AND routing_action = '${input.kind === 'auto_parked' ? 'park' : 'revision'}'`;
        try {
            return await this.transaction(async (m) => {
                const marked = await m.createQueryBuilder().update(PrReview)
                    .set({ suppressed: true, overriddenAt: now, overriddenById: input.actorId, overrideReason: input.reason })
                    .where(`id = :id AND suppressed = :no AND ${routing}`, { id: review.id, no: false })
                    .execute();
                if (!marked.affected) throw new RollbackOverride();
                const query = m.createQueryBuilder().update(Job)
                    .set({ status: to, autoRevisionReviewId: null, ...(from === 'pr_open' ? {} : { lastReason: null, waitingReason: null, nextRoundKind: null }) })
                    .where('id = :id AND head_sha = :head AND pr_number = :pr AND status = :from', {
                        id: review.jobId, head: review.headSha, pr: review.prNumber, from,
                    });
                if (input.kind === 'auto_revision_queued') query.andWhere('auto_revision_review_id = :rid', { rid: review.id });
                const moved = await query.execute();
                if (!moved.affected) throw new RollbackOverride();
                const fresh = await m.getRepository(PrReview).findOneByOrFail({ id: review.id });
                await m.getRepository(PrReview).save({ id: review.id, overriddenResult: {
                    status: fresh.status, verdict: fresh.verdict, reasonCode: fresh.reasonCode,
                    routingState: fresh.routingState, routingAction: fresh.routingAction, jobStatus: from,
                } });
                return {
                    applied: true,
                    job: await m.getRepository(Job).findOneByOrFail({ id: review.jobId }),
                    review: await m.getRepository(PrReview).findOneByOrFail({ id: review.id }),
                } as const;
            });
        } catch (e) {
            if (e instanceof RollbackOverride) return { applied: false };
            throw e;
        }
    }

    /**
     * A publication that failed turns the final result into a visible error that keeps the findings (they are never sent back
     * automatically). Only before routing and before a publication was recorded.
     */
    async markPublicationFailed(reviewId: string, detail: string): Promise<PrReview | null> {
        const review = await this.reviews.findOneBy({ id: reviewId });
        const r = review?.result;
        if (!review || !r || (r.kind !== 'complete' && r.kind !== 'incomplete')) return null;
        const reason = `The review could not be published to GitHub: ${detail.slice(0, 300)}`;
        const failed = ReviewResultSchema.parse({
            kind: 'error', reasonCode: 'publication_failed', reason,
            partialFindings: r.kind === 'complete' ? r.blockingFindings : r.partialFindings, suggestions: r.suggestions,
        });
        const res = await this.reviews.createQueryBuilder().update(PrReview)
            .set({ status: 'error', verdict: null, reasonCode: 'publication_failed', reason, result: failed })
            .where(`id = :id AND status IN ('complete', 'incomplete') AND routing_state = 'unclaimed' AND publication_id IS NULL`, { id: reviewId })
            .execute();
        return res.affected ? this.reviews.findOneByOrFail({ id: reviewId }) : null;
    }

    /** Final reviews that no one routed yet, completed before `before`: the recovery path of a crash between result and routing. */
    listUnrouted(before: Date, limit = 50): Promise<PrReview[]> {
        return this.reviews.createQueryBuilder('r')
            .where(`r.status IN (:...fin) AND r.routing_state = 'unclaimed' AND r.suppressed = :no AND r.completed_at < :before`, { fin: FINAL_PR_REVIEW_STATUSES, no: false, before })
            .orderBy('r.completed_at', 'ASC').limit(limit).getMany();
    }

    /** claimed → done, after the routing action was applied to the job. */
    async completeRouting(reviewId: string): Promise<boolean> {
        const res = await this.reviews.createQueryBuilder().update(PrReview)
            .set({ routingState: 'done', routedAt: new Date() })
            .where(`id = :id AND routing_state = 'claimed'`, { id: reviewId })
            .execute();
        return !!res.affected;
    }

    /** Clears the pending automatic revision provenance once that revision is dispatched or cancelled. */
    async clearPendingRevision(jobId: string, reviewId: string): Promise<boolean> {
        const res = await this.jobs.createQueryBuilder().update(Job)
            .set({ autoRevisionReviewId: null })
            .where('id = :jobId AND auto_revision_review_id = :reviewId', { jobId, reviewId })
            .execute();
        return !!res.affected;
    }

    findById(id: string): Promise<PrReview | null> {
        return this.reviews.findOneBy({ id });
    }

    /** Reviews that were claimed but whose model call never started; safe to start. */
    listPending(limit = 50, before?: Date): Promise<PrReview[]> {
        const q = this.reviews.createQueryBuilder('r').where(`r.status = 'pending'`);
        if (before) q.andWhere('r.created_at < :before', { before });
        return q.orderBy('r.created_at', 'ASC').limit(limit).getMany();
    }

    /**
     * After a restart: an execution this process did not start and that has no result was cut off. It becomes an incomplete
     * result (never repeated), and never-started work whose job moved on is superseded. Assumes one API process; a second one
     * is covered by the timeout-based `sweep`.
     */
    async recoverOnStartup(): Promise<number> {
        const abandoned = (await this.reviews.find({ where: { status: 'running' } })).filter((r) => r.claimedBy !== this.instanceId);
        return (await this.abandon(abandoned)) + (await this.supersedeStalePending());
    }

    /** Periodic safety net: running past their own timeout plus a grace period, and pending work whose job moved on. */
    @Cron(CronExpression.EVERY_MINUTE)
    async sweep(now: Date = new Date()): Promise<number> {
        try {
            const running = await this.reviews.find({ where: { status: 'running' } });
            const overdue = running.filter((r) => {
                const timeout = ReviewLimitsSchema.safeParse(r.limits).data?.timeoutMs ?? FALLBACK_TIMEOUT_MS;
                return (r.startedAt?.getTime() ?? 0) + timeout + ABANDONED_GRACE_MS < now.getTime();
            });
            return (await this.abandon(overdue)) + (await this.supersedeStalePending());
        } catch (e) {
            this.logger.error(`Review sweep failed: ${(e as Error).message}`);
            return 0;
        }
    }

    private async abandon(rows: PrReview[]): Promise<number> {
        let n = 0;
        for (const r of rows) {
            const done = await this.complete(r.id, {
                kind: 'incomplete', reasonCode: 'abandoned', reason: ABANDONED_REASON, partialFindings: [], suggestions: [],
            }, { model: r.model });
            if (done) n++;
        }
        return n;
    }

    private async supersedeStalePending(): Promise<number> {
        const pending = await this.reviews.find({ where: { status: 'pending' } });
        if (pending.length === 0) return 0;
        const jobs = await this.jobs.findBy({ id: In([...new Set(pending.map((r) => r.jobId))]) });
        const byId = new Map(jobs.map((j) => [j.id, j]));
        let n = 0;
        for (const r of pending) {
            const j = byId.get(r.jobId);
            if (j && j.headSha === r.headSha && j.prNumber === r.prNumber && REVIEW_FENCE_STATUSES.includes(j.status)) continue;
            const done = await this.complete(r.id, {
                kind: 'skipped', reasonCode: 'superseded', reason: 'The job moved on before the review started',
            });
            if (done) n++;
        }
        return n;
    }

    /** The review history of a job, newest first, with the job's durable automatic revision count. */
    async listForJob(jobId: string, q: PrReviewHistoryQuery): Promise<PrReviewPageDto> {
        const job = await this.jobs.findOneBy({ id: jobId });
        if (!job) throw new NotFoundException(`Job ${jobId} not found`);
        const page = q.page ?? 1;
        const pageSize = q.pageSize ?? DEFAULT_PR_REVIEW_PAGE_SIZE;
        const [rows, total] = await this.reviews.findAndCount({
            where: { jobId },
            order: { createdAt: 'DESC', id: 'DESC' },
            skip: (page - 1) * pageSize,
            take: pageSize,
        });
        return { items: rows.map((r) => toPrReviewDto(r, job.prUrl)), page, pageSize, total, revisionCount: job.autoReviewRevisions };
    }

    private find(t: ReviewTarget, repo: Repository<PrReview> = this.reviews): Promise<PrReview | null> {
        return repo.findOneBy({ jobId: t.jobId, prNumber: t.prNumber, headSha: t.headSha });
    }
}

/** SQLite has one connection per DataSource and cannot overlap transactions on it; Postgres relies on the conditional writes alone. */
const sqliteMutexes = new WeakMap<DataSource, KeyedMutex>();
function sqliteMutexFor(ds: DataSource): KeyedMutex {
    let mutex = sqliteMutexes.get(ds);
    if (!mutex) sqliteMutexes.set(ds, mutex = new KeyedMutex());
    return mutex;
}

/** The job still has this review's PR and head and is in a fenced state. */
const FENCE = `EXISTS (SELECT 1 FROM jobs j WHERE j.id = pr_reviews.job_id AND j.head_sha = pr_reviews.head_sha AND j.pr_number = pr_reviews.pr_number AND j.status IN (:...st))`;

function base(t: { baseSha?: string | null; baseRef?: string | null } & ReviewTarget, job: Job) {
    return {
        jobId: t.jobId, projectId: job.projectId, repoId: job.repoId, prNumber: t.prNumber, headSha: t.headSha,
        baseSha: t.baseSha ?? null, baseRef: t.baseRef ?? null,
    };
}

