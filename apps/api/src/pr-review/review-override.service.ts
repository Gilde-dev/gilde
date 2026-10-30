import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { GITHUB_PORT, type GitHubPort } from '../github/github.port.js';
import { Job } from '../job/job.entity.js';
import { TERMINAL } from '../job/job-state.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { UserService } from '../user/user.service.js';

import { checkHeadFresh, ciPolicyFromEnv, type CiPolicy } from './head-freshness.js';
import type { PrReviewDto, PrReviewOverrideDto } from './pr-review.dto.js';
import type { PrReview } from './pr-review.entity.js';
import { toPrReviewDto } from './pr-review.mapper.js';
import { PrReviewService, type OverrideKind } from './pr-review.service.js';

/**
 * A verified human's audited override of the automatic review decision of a job's current green head: the job goes to
 * awaiting_review for a human. Only a pending automatic revision can be cancelled; running work, CI, executor gates and
 * protected-path approval are never touched. The decision is rechecked atomically in `PrReviewService.applyOverride`, so
 * the checks here only give precise errors and avoid pointless GitHub reads.
 */
@Injectable()
export class ReviewOverrideService {
    private readonly logger = new Logger('ReviewOverride');

    constructor(
        private readonly users: UserService,
        private readonly reviews: PrReviewService,
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @Optional() private readonly capture?: NotificationCaptureService,
        @Optional() private readonly ci: CiPolicy = ciPolicyFromEnv(),
    ) { }

    async override(user: AuthUser | undefined, jobId: string, dto: PrReviewOverrideDto): Promise<PrReviewDto> {
        const human = await this.users.requireVerifiedHuman(user);
        const job = await this.jobs.findOneBy({ id: jobId });
        if (!job) throw new NotFoundException(`Job ${jobId} not found`);
        const review = await this.reviews.findById(dto.reviewId);
        if (!review || review.jobId !== job.id) throw new NotFoundException(`Review ${dto.reviewId} not found for this job`);

        const kind = await this.eligibility(job, review, dto.headSha);
        await this.verifyGreenHead(job, dto.headSha);

        const applied = await this.reviews.applyOverride({ kind, reviewId: review.id, actorId: human.id, reason: dto.reason });
        if (!applied.applied) throw new ConflictException('The job or its automatic review changed while overriding; refresh and check again');
        try {
            await this.capture?.jobAwaitingReview(applied.job, `Automatic review overridden by ${human.email}: ${dto.reason}`);
        } catch (e) {
            this.logger.error(`Job ${job.id}: notifying about the override failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return toPrReviewDto(applied.review, applied.job.prUrl);
    }

    /** Which override applies, or a 409 saying why none does. */
    private async eligibility(job: Job, review: PrReview, expectedHead: string): Promise<OverrideKind> {
        if (TERMINAL.has(job.status)) throw new ConflictException(`The job is ${job.status}; nothing to override`);
        if (job.prNumber === null || !job.headSha || job.headSha !== expectedHead) {
            throw new ConflictException('The job has a different head than the one you reviewed; refresh and check again');
        }
        if (review.headSha !== job.headSha || review.prNumber !== job.prNumber) {
            throw new ConflictException('That automatic review belongs to an older head; a new head needs fresh CI and review');
        }
        if (review.suppressed) throw new ConflictException('That automatic decision was already overridden');

        const active = await this.runs.countBy({ jobId: job.id, status: In(['firing', 'fired']) });
        if (active > 0) throw new ConflictException('A coding round is running; it is not cancelled by an override');

        if (job.status === 'pr_open' && review.routingState === 'unclaimed') return 'review_pending';
        if (review.routingState === 'done' && job.status === 'parked' && review.routingAction === 'park') {
            if (review.routedAt && (await this.runs.countBy({ jobId: job.id, createdAt: MoreThan(review.routedAt) })) > 0) {
                throw new ConflictException('The job ran again after the automatic park');
            }
            return 'auto_parked';
        }
        if (review.routingState === 'done' && job.status === 'queued' && review.routingAction === 'revision' && job.autoRevisionReviewId === review.id) {
            return 'auto_revision_queued';
        }
        throw new ConflictException('The job is not waiting on this automatic review decision');
    }

    private async verifyGreenHead(job: Job, head: string): Promise<void> {
        const fullName = (await this.repos.findOneBy({ id: job.repoId }))?.fullName;
        if (!fullName) throw new ConflictException('The job\'s repo no longer exists');
        let fresh;
        try {
            fresh = await checkHeadFresh(this.github, fullName, job.prNumber!, head, this.ci);
        } catch (e) {
            this.logger.warn(`Job ${job.id}: cannot verify PR #${job.prNumber} and CI: ${e instanceof Error ? e.message : String(e)}`);
            throw new ServiceUnavailableException('GitHub could not be read to verify the PR and its CI; try again');
        }
        if (!fresh.ok) throw new ConflictException(`Cannot override: ${fresh.why}`);
    }
}
