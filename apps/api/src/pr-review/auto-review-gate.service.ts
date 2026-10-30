import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GITHUB_PORT, type GitHubPort, type GitHubPull } from '../github/github.port.js';
import { Job } from '../job/job.entity.js';
import { LessonService } from '../lesson/lesson.service.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';

import { checkHeadFresh, type CiPolicy } from './head-freshness.js';
import { PrReview } from './pr-review.entity.js';
import { PrReviewService, REVIEW_FENCE_STATUSES, type RoutingPlan } from './pr-review.service.js';
import { parkReason, renderReviewBody, revisionReason } from './review-publication.js';
import { recoverPublishedReview, reviewMarker } from './review-marker.js';
import { ReviewExecutionService } from './review-execution.service.js';
import { isActionableBlocking, type ReviewResult, type SkippedReview } from './review-result.js';

/** A claimed or unrouted review younger than this is probably still being handled by this process; the recovery leaves it alone. */
const RECOVERY_MIN_AGE_MS = 30_000;

export type { CiPolicy };

export type GateOutcome =
    /** The job moved to a human (awaiting_review) now. */
    | { routed: 'human'; job: Job }
    /** The review runs in the background; the job stays pr_open and no readiness is announced. */
    | { routed: 'pending' }
    /** Not eligible yet or any more (CI not green on the current head, draft, closed, stale): nothing changed. */
    | { routed: 'none'; why: string };

/**
 * The durable automatic-review gate between green CI and human readiness. A green observation (webhook or reconcile) only
 * asks the gate; the gate re-reads the PR and the tracked CI of the head, claims the one review row of that head, runs the
 * review in the background and routes by its result: clean, incomplete and failed reviews go to a human (awaiting_review), a
 * published complete blocking result queues a same-PR revision while the limits allow, and an exhausted limit parks the job.
 * All state lives in the database (the review row and the fenced job writes), so duplicate observations, workers and
 * restarts do not repeat the model call or the routing.
 */
@Injectable()
export class AutoReviewGateService {
    private readonly logger = new Logger('AutoReview');
    private readonly inflight = new Map<string, Promise<void>>();

    constructor(
        private readonly reviews: PrReviewService,
        private readonly execution: ReviewExecutionService,
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Project) private readonly projects: Repository<Project>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @Optional() private readonly capture?: NotificationCaptureService,
        @Optional() private readonly lessons?: LessonService,
    ) { }

    /**
     * Green CI was observed for the job's current head. Returns once the review is claimed (the model runs in the
     * background) or the job is routed to a human without one. Never throws for a GitHub read failure: the job simply stays
     * in pr_open and the next observation tries again.
     */
    async onCiPassed(jobId: string, observedHead: string, ci: CiPolicy): Promise<GateOutcome> {
        const job = await this.jobs.findOneBy({ id: jobId });
        if (!job || job.status !== 'pr_open' || job.prNumber === null || job.headSha !== observedHead) {
            return { routed: 'none', why: `job is not waiting for CI on ${observedHead.slice(0, 7)}` };
        }
        const target = { jobId, prNumber: job.prNumber, headSha: observedHead };
        const project = await this.projects.findOneBy({ id: job.projectId });

        // Opted out: the previous CI-to-human path, with a persisted reason why no review ran.
        if (!project?.autoReview) {
            return this.skipToHuman(target, { kind: 'skipped', reasonCode: 'project_opt_out', reason: 'Automatic review is off for this project' });
        }
        const reviewer = await this.execution.resolve();
        if (!reviewer.ok) return this.skipToHuman(target, reviewer.skip);

        let pull: GitHubPull;
        const fullName = (await this.repos.findOneBy({ id: job.repoId }))?.fullName;
        if (!fullName) return { routed: 'none', why: 'the job\'s repo no longer exists' };
        try {
            const fresh = await this.freshness(fullName, job, ci);
            if (!fresh.ok) return { routed: 'none', why: fresh.why };
            pull = fresh.pull;
        } catch (e) {
            this.logger.warn(`Job ${jobId}: cannot verify PR #${job.prNumber} and CI on GitHub, will retry: ${message(e)}`);
            return { routed: 'none', why: 'GitHub could not be read' };
        }

        const claim = await this.reviews.claimExecution({ ...target, limits: reviewer.limits, baseSha: pull.baseSha ?? null, baseRef: pull.baseRef ?? null });
        if (!claim.claimed) {
            if (!claim.review) return { routed: 'none', why: 'the job moved on' };
            return this.resume(claim.review);
        }
        await this.recordCi(job);
        this.spawn(claim.review.id);
        return { routed: 'pending' };
    }

    /** A review row exists already (duplicate or later observation): finish whatever is still open on it, never start a second one. */
    private async resume(review: PrReview): Promise<GateOutcome> {
        if (review.status === 'pending' || review.status === 'running') return { routed: 'pending' };
        if (review.routingState !== 'unclaimed') return { routed: 'none', why: `head ${review.headSha.slice(0, 7)} is already routed` };
        this.spawn(review.id);
        return { routed: 'pending' };
    }

    private async skipToHuman(target: { jobId: string; prNumber: number; headSha: string }, skip: SkippedReview): Promise<GateOutcome> {
        const claim = await this.reviews.recordSkip(target, skip);
        const review = claim.review;
        if (!review) return { routed: 'none', why: 'the job moved on' };
        if (review.routingState !== 'unclaimed') return { routed: 'none', why: `head ${review.headSha.slice(0, 7)} is already routed` };
        const routed = await this.route(review.id);
        return routed ?? { routed: 'none', why: 'the job moved on' };
    }

    private freshness(fullName: string, job: Job, ci: CiPolicy) {
        return checkHeadFresh(this.github, fullName, job.prNumber!, job.headSha!, ci);
    }

    /** The coding run's CI conclusion is recorded while the review is pending; the human is not told yet. */
    private async recordCi(job: Job): Promise<void> {
        const run = await this.runs.findOne({ where: { jobId: job.id }, order: { attempt: 'DESC' } });
        if (run) await this.runs.update({ id: run.id }, { status: 'ci_passed', ciConclusion: 'success' });
    }

    /** Starts `process` once per review in this process; the database makes it once overall. */
    private spawn(reviewId: string): void {
        if (this.inflight.has(reviewId)) return;
        const work = this.process(reviewId)
            .catch((e) => this.logger.error(`Review ${reviewId}: ${message(e)}`))
            .finally(() => this.inflight.delete(reviewId));
        this.inflight.set(reviewId, work);
    }

    /** Resolves when the work started in this process is finished (tests, shutdown). */
    async idle(): Promise<void> {
        while (this.inflight.size) await Promise.all([...this.inflight.values()]);
    }

    /** Executes (when still pending), publishes and routes one review. Safe to call again for the same review. */
    async process(reviewId: string): Promise<void> {
        let review = await this.reviews.findById(reviewId);
        if (!review) return;
        if (review.status === 'pending') {
            if (!(await this.stillCurrent(review))) return;
            await this.execution.run(reviewId);
            review = await this.reviews.findById(reviewId);
            if (!review) return;
        }
        if (review.status === 'pending' || review.status === 'running') return;
        if (review.routingState !== 'unclaimed' || review.suppressed) return;
        if (!(await this.stillCurrent(review))) return;
        if (!review.publicationId && (review.status === 'complete' || review.status === 'incomplete')) {
            review = await this.publish(review);
            if (!review) return;
        }
        await this.route(review.id);
    }

    private async stillCurrent(review: PrReview): Promise<boolean> {
        const job = await this.jobs.findOneBy({ id: review.jobId });
        return !!job && job.headSha === review.headSha && job.prNumber === review.prNumber && REVIEW_FENCE_STATUSES.includes(job.status);
    }

    /**
     * Publishes the COMMENT review bound to the head. An earlier uncertain attempt is looked up by its marker first. A failure
     * turns the result into a visible publication error (findings kept) that only a human sees.
     */
    private async publish(review: PrReview): Promise<PrReview | null> {
        const result = review.result;
        if (!result) return review;
        const fullName = (await this.repos.findOneBy({ id: review.repoId }))?.fullName;
        try {
            if (!fullName) throw new Error('the repo no longer exists');
            let ref = await recoverPublishedReview(this.github, fullName, review.prNumber, review.id, review.headSha);
            if (!ref) {
                ref = await this.github.publishCommentReview(fullName, review.prNumber, {
                    commitId: review.headSha, marker: reviewMarker(review.id, review.headSha), body: renderReviewBody(review, result),
                });
            }
            await this.reviews.recordPublication(review.id, { id: ref.id, url: ref.htmlUrl });
        } catch (e) {
            this.logger.warn(`Review ${review.id}: publication failed: ${message(e)}`);
            await this.reviews.markPublicationFailed(review.id, message(e));
        }
        return this.reviews.findById(review.id);
    }

    /** Applies the one routing action of a final review. Returns the outcome when this call moved the job. */
    private async route(reviewId: string): Promise<GateOutcome | null> {
        const review = await this.reviews.findById(reviewId);
        const result = review?.result;
        if (!review || !result) return null;
        const job = await this.jobs.findOneBy({ id: review.jobId });
        if (!job) return null;

        const findings = result.kind === 'complete' ? result.blockingFindings : [];
        let plan: RoutingPlan = { action: 'human' };
        if (isActionableBlocking(result) && review.status === 'complete') {
            const project = await this.projects.findOneBy({ id: job.projectId });
            plan = { action: 'revision', reason: revisionReason(review, findings), maxAttempts: project?.maxAttempts ?? job.attempts };
        }

        let applied = await this.reviews.applyRouting(review.id, plan);
        if (!applied.applied && (applied.reason === 'revisions_exhausted' || applied.reason === 'attempts_exhausted')) {
            const limit = applied.reason === 'revisions_exhausted'
                ? `the limit of automatic review revisions was reached`
                : `the job has used all its attempts`;
            applied = await this.reviews.applyRouting(review.id, { action: 'park', reason: parkReason(limit, review, findings) });
            plan = { action: 'park', reason: parkReason(limit, review, findings) };
        }
        if (!applied.applied) return null;

        await this.after(applied.job, review, result, plan);
        return plan.action === 'human' ? { routed: 'human', job: applied.job } : { routed: 'pending' };
    }

    /** Side effects of the routing this call applied, once: the winner of the conditional write is the only one here. */
    private async after(job: Job, review: PrReview, result: ReviewResult, plan: RoutingPlan): Promise<void> {
        try {
            if (plan.action === 'human') {
                await this.recordCi(job);
                await this.capture?.jobAwaitingReview(job, humanNote(review, result));
            }
            if (plan.action === 'park') {
                await this.lessons?.onJobEnded(job.id, 'parked', plan.reason);
                await this.capture?.jobParked(job, plan.reason, 'auto_review');
            }
        } catch (e) {
            this.logger.error(`Review ${review.id}: notifying about the routing failed: ${message(e)}`);
        }
    }

    /**
     * Restart and crash recovery, every minute: reviews that were claimed but never started are started, and final results
     * that were never routed are published (if needed) and routed. Nothing here repeats a model execution.
     */
    @Cron(CronExpression.EVERY_MINUTE)
    async recover(now: Date = new Date()): Promise<number> {
        const before = new Date(now.getTime() - RECOVERY_MIN_AGE_MS);
        let n = 0;
        try {
            for (const r of await this.reviews.listPending(50, before)) { this.spawn(r.id); n++; }
            for (const r of await this.reviews.listUnrouted(before)) { this.spawn(r.id); n++; }
        } catch (e) {
            this.logger.error(`Review recovery failed: ${message(e)}`);
        }
        return n;
    }
}

function humanNote(review: PrReview, result: ReviewResult): string {
    const link = review.publicationUrl ? ` ${review.publicationUrl}` : '';
    switch (result.kind) {
        case 'complete': return `Automatic review ${result.verdict === 'pass' ? 'found no blocking issues' : 'found issues'}.${link}`;
        case 'incomplete': return `Automatic review incomplete: ${result.reason}.${link}`;
        case 'error': return `Automatic review failed: ${result.reason}`;
        case 'skipped': return result.reasonCode === 'project_opt_out' ? '' : `Automatic review skipped: ${result.reason}`;
    }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
