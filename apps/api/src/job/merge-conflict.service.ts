import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GITHUB_PORT, type GitHubPort, type GitHubPull } from '../github/github.port.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobEventsService } from './job-events.service.js';
import type { JobStatus } from './job-state.js';
import { Job } from './job.entity.js';

/** Statuses in which a job's open PR can be sent back to fix conflicts. */
const FIXABLE: readonly JobStatus[] = ['pr_open', 'awaiting_review'];
/** Statuses in which the PR is still open and its mergeability is worth tracking. */
const TRACKED: readonly JobStatus[] = ['queued', 'dispatched', 'pr_open', 'awaiting_review', 'parked'];

/** GitHub's `mergeable_state` as a conflict flag: true for conflicts, false for a PR without, null when GitHub does not know (yet). */
export function mergeConflictFrom(state: string | null | undefined): boolean | null {
    switch (state) {
        case 'dirty':
            return true;
        case 'clean': case 'has_hooks': case 'unstable': case 'behind': case 'blocked': case 'draft':
            return false;
        default:
            return null; // 'unknown', null, anything new: neither clean nor conflicted
    }
}

/** The fixed instruction of a conflict-fix round: merge, never rebase, and no scope changes. */
export const conflictFixReason = (base: string) =>
    `Merge conflicts with ${base}. Run \`git fetch origin && git merge origin/${base}\` into this branch (do not rebase or force-push), resolve the conflicts keeping the intent of both sides, make no scope changes or new features, run the full test commands including e2e, and push to the same branch. If a conflict needs a design decision, report blocked and list the conflicting files.`;

/** Tracks whether agent PRs conflict with their base branch, and starts the conflict-fix rounds. */
@Injectable()
export class MergeConflictService {
    private readonly logger = new Logger(MergeConflictService.name);

    constructor(
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
        private readonly events: JobEventsService,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Project) private readonly projects: Repository<Project>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
    ) { }

    /**
     * Stores the mergeability GitHub reported for the job's open PR. An unknown state changes nothing (it is checked again on
     * the next pass); a closed PR is left to the close handling. With the project's autoFixConflicts on, a new conflict starts
     * one fix round for the PR head.
     */
    async applyPull(job: Job, pull: GitHubPull): Promise<void> {
        if (pull.state !== 'open' || job.prNumber !== pull.number || !TRACKED.includes(job.status)) return;
        const conflict = mergeConflictFrom(pull.mergeableState);
        if (conflict === null) return;
        await this.jobs.update({ id: job.id }, { mergeConflict: conflict, mergeConflictCheckedAt: new Date() });
        if (conflict) await this.autoFix(job.id, pull.headSha);
    }

    /** Reads the job's PR from GitHub and applies it. A failed read is logged and changes nothing. */
    async checkJob(job: Job): Promise<void> {
        if (job.prNumber === null || !this.github.isConfigured()) return;
        try {
            const repo = await this.repos.findOneBy({ id: job.repoId });
            if (!repo) return;
            await this.applyPull(job, await this.github.getPull(repo.fullName, job.prNumber));
        } catch (e) {
            this.logger.warn(`Merge check of job ${job.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Re-checks the open agent PRs of a repo, after its default branch moved. */
    async checkRepo(repoId: string): Promise<number> {
        const open = (await this.jobs.find({ where: FIXABLE.map((status) => ({ repoId, status })) })).filter((j) => j.prNumber !== null);
        for (const job of open) await this.checkJob(job);
        return open.length;
    }

    /** Re-checks the job with this PR number, after a synchronize event. */
    async checkPr(repoId: string, prNumber: number): Promise<void> {
        const job = await this.jobs.findOneBy({ repoId, prNumber });
        if (job) await this.checkJob(job);
    }

    /** Sends a conflicted job back with the fixed merge instruction; the round uses no attempt. 404 for an unknown job, 409 when not applicable. */
    async fixConflicts(id: string): Promise<Job['status']> {
        const job = await this.jobs.findOneBy({ id });
        if (!job) throw new NotFoundException('Job not found');
        const reason = notFixableReason(job);
        if (reason) throw new ConflictException(reason);
        const to = await this.events.retryOrParkJob(job, conflictFixReason(await this.baseBranch(job)), 'sent_back', 'conflict_fix');
        if (!to) throw new ConflictException('Job changed in the meantime, try again');
        return to;
    }

    /** At most one automatic round per PR head: the head is claimed with a conditional write before the job is sent back. */
    private async autoFix(jobId: string, headSha: string): Promise<void> {
        try {
            const job = await this.jobs.findOneBy({ id: jobId });
            if (!job || !job.mergeConflict || notFixableReason(job)) return;
            if (!(await this.projects.findOneBy({ id: job.projectId }))?.autoFixConflicts) return;
            const claim = await this.jobs.createQueryBuilder()
                .update(Job)
                .set({ autoFixHeadSha: headSha })
                .where('id = :id AND status = :status AND (auto_fix_head_sha IS NULL OR auto_fix_head_sha <> :headSha)', { id: job.id, status: job.status, headSha })
                .execute();
            if (claim.affected !== 1) return;
            await this.fixConflicts(job.id);
            this.logger.log(`Job ${job.id}: automatic conflict-fix round started for ${headSha.slice(0, 7)}`);
        } catch (e) {
            this.logger.warn(`Automatic conflict fix for job ${jobId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async baseBranch(job: Job): Promise<string> {
        return (await this.repos.findOneBy({ id: job.repoId }))?.defaultBranch ?? 'main';
    }
}

/** Why a job cannot take a conflict-fix round (a 409 reason), or null when it can. */
export function notFixableReason(job: Pick<Job, 'status' | 'prNumber' | 'mergeConflict'>): string | null {
    if (job.prNumber === null) return `Cannot fix conflicts of a job without a PR`;
    if (!FIXABLE.includes(job.status)) return `Cannot fix conflicts of a job that is ${job.status}`;
    if (!job.mergeConflict) return 'The PR has no known merge conflict';
    return null;
}
