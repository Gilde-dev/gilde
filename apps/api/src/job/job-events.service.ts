import { mergeOperatorActions } from '../run/operator-actions.js';
import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AgentRunRecorder } from '../agent-run/agent-run.recorder.js';
import { TERMINAL, nextStatus, retryOrPark, type JobEvent } from './job-state.js';
import { Job } from './job.entity.js';
import { RepoManifestService } from '../repo/repo-manifest.service.js';
import { LessonService } from '../lesson/lesson.service.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';
import type { RunKind } from '../run/run-status.js';
import { NotificationCaptureService, type ParkCause } from '../notification/notification-capture.service.js';
import { ProposalService } from '../revision/proposal.service.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import { parsePrBody, type ParsedPrBody } from '../webhook/pr-body.js';

export interface PullInfo {
    number: number;
    htmlUrl: string;
    body: string | null;
    headRef: string;
    headSha: string;
}

export interface WorkflowRunInfo {
    name: string;
    conclusion: string | null;
    headSha: string;
}

const APPROVAL_REASON = 'Protected paths changed; add the gilde:allow-protected label if intended';
const CI_OK = new Set(['success', 'neutral', 'skipped']);

/** The job-changing logic shared by the GitHub webhook and the reconciler. Methods return a human-readable outcome. */
@Injectable()
export class JobEventsService {
    private readonly logger = new Logger(JobEventsService.name);
    private readonly ciWorkflows = workflowNames(process.env.GILDE_CI_WORKFLOWS, 'CI');
    private readonly gateWorkflows = workflowNames(process.env.GILDE_GATE_WORKFLOWS, 'Gates');

    constructor(
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @InjectRepository(Project) private readonly projects: Repository<Project>,
        @Optional() private readonly lessons?: LessonService,
        @Optional() private readonly manifests?: RepoManifestService,
        @Optional() private readonly proposals?: ProposalService,
        @Optional() private readonly capture?: NotificationCaptureService,
        @Optional() private readonly scout?: ScoutSignalPublisher,
        @Optional() private readonly agentRuns?: AgentRunRecorder,
    ) { }

    isGateWorkflow(name: string): boolean {
        return this.gateWorkflows.has(name);
    }

    isTrackedWorkflow(name: string): boolean {
        return this.gateWorkflows.has(name) || this.ciWorkflows.has(name);
    }

    /** Links a PR carrying a gilde-job marker to its job (opened, reopened, ready for review, or found by the reconciler). */
    async linkPr(repoId: string, pr: PullInfo): Promise<string> {
        const parsed = parsePrBody(pr.body);
        if (!parsed.jobId) return `ignored: PR #${pr.number} has no gilde-job marker`;
        const job = await this.jobs.findOneBy({ id: parsed.jobId, repoId });
        if (!job) return `ignored: PR #${pr.number} references unknown job`;
        if (TERMINAL.has(job.status)) return `ignored: job is ${job.status}`;
        if (job.prNumber !== null && job.prNumber !== pr.number) {
            return `ignored: job already has PR #${job.prNumber}`;
        }
        // Redelivery (or reopen without new commits): don't pull a job back from awaiting_review.
        if (job.prNumber === pr.number && job.headSha === pr.headSha) {
            return `unchanged: job ${job.status} with PR #${pr.number}`;
        }

        const to = await this.transition(job, 'pr_activity', {
            prNumber: pr.number,
            prUrl: pr.htmlUrl,
            branch: pr.headRef,
            headSha: pr.headSha,
        });
        if (!to) return `ignored: job ${job.status} cannot take pr_activity`;

        const run = await this.findRun(job.id, parsed.runId);
        if (run) {
            await this.runs.update(
                { id: run.id, status: In(['firing', 'fired', 'pr_opened']) },
                { status: 'pr_opened', result: parsed.result, resultError: parsed.resultError, retro: parsed.retro, operatorActions: mergeOperatorActions(run.operatorActions, parsed.result?.operatorActions) },
            );
            await this.recordProposals(job, run, parsed);
            // The agent's work is done once it opened the PR: blocked is the agent declining the task.
            const result = parsed.result;
            await this.agentRuns?.endLinked('job_runs', run.id, result?.outcome === 'blocked'
                ? { outcome: 'refused', reason: result.summary }
                : { outcome: 'ok', reason: result && result.outcome !== 'done' ? `${result.outcome}: ${result.summary}` : null });
        }
        return `job ${to} with PR #${pr.number}`;
    }

    /**
     * Runs once the run row holds the parsed body: parks a job whose current run reports blocked, keeps the merged-blocked
     * flag in step, tells the scout and stores the PR body's proposals. A failure is logged and never fails the event.
     */
    async recordProposals(job: Job, run: JobRun, parsed: ParsedPrBody): Promise<void> {
        await this.parkOnBlocked(job, run, parsed);
        await this.notifyRunOutcome(job, run, parsed);
        if (!this.proposals) return;
        try {
            await this.proposals.record(run, job, parsed.proposals, parsed.proposalsError);
        } catch (e) {
            this.logger.error(`Run ${run.id}: recording proposals failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Parks the job when the current run's stored result is blocked. The run is re-read (the caller's copy predates the
     * write and a conditional write may not have landed) and must be the job's latest attempt, so an older attempt's
     * body never parks it. The park is a conditional state transition: edits, redeliveries and concurrent calls park and
     * notify once. Never throws; never consumes attempts or requeues.
     */
    private async parkOnBlocked(job: Job, run: JobRun, parsed: ParsedPrBody): Promise<void> {
        try {
            await this.syncMergedBlocked(job.id);
            if (parsed.result?.outcome !== 'blocked') return;
            if (parsed.runId && parsed.runId !== run.id) return;
            const [stored, latest, current] = await Promise.all([
                this.runs.findOneBy({ id: run.id }),
                this.latestRun(job.id),
                this.jobs.findOneBy({ id: job.id }),
            ]);
            if (!stored || !current || latest?.id !== stored.id) return;
            if (stored.result?.outcome !== 'blocked' || JSON.stringify(stored.result) !== JSON.stringify(parsed.result)) return;
            const reason = `Blocked: ${stored.result.summary}. Close the PR, fix the cause, then retry.`;
            const to = await this.transition(current, 'park', { lastReason: reason });
            if (to !== 'parked') return;
            this.logger.log(`Job ${job.id} parked: run ${stored.id} reported blocked`);
            await this.lessons?.onJobEnded(job.id, to, reason);
            await this.capture?.jobParked({ ...current, status: to, lastReason: reason }, reason, 'blocked');
        } catch (e) {
            this.logger.error(`Run ${run.id}: parking on a blocked result failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Sets `mergedBlocked` from the stored latest run of a merged job (false for any other job). Returns the new value.
     * It reads the stored result, never the parsed body, so a lost write or an older attempt cannot set it.
     */
    async syncMergedBlocked(jobId: string): Promise<boolean> {
        const job = await this.jobs.findOneBy({ id: jobId });
        if (!job) return false;
        const latest = job.status === 'merged' ? await this.latestRun(jobId) : null;
        const blocked = latest?.result?.outcome === 'blocked';
        if (job.mergedBlocked !== blocked) await this.jobs.update({ id: jobId }, { mergedBlocked: blocked });
        return blocked;
    }

    /**
     * Tells the scout about a blocked or partial result, once the run row really holds that result. Runs on every call of
     * the shared post-persistence hook, whether or not proposals are collected; the run is re-read because the caller's
     * object predates the update and a conditional update may not have applied. Never throws.
     */
    private async notifyRunOutcome(job: Job, run: JobRun, parsed: ParsedPrBody): Promise<void> {
        const outcome = parsed.result?.outcome;
        if (!this.scout?.active || (outcome !== 'blocked' && outcome !== 'partial')) return;
        try {
            const stored = await this.runs.findOneBy({ id: run.id });
            if (!stored?.result || JSON.stringify(stored.result) !== JSON.stringify(parsed.result)) return;
            await this.scout.publish(job.projectId, { type: 'run_outcome', outcome, jobId: job.id, runId: run.id, repoId: job.repoId });
        } catch (e) {
            this.logger.warn(`Run ${run.id}: telling the scout about the outcome failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** New commits on the job's PR. */
    async prUpdated(job: Job, prNumber: number, headSha: string): Promise<string> {
        if (job.headSha === headSha) return `unchanged: job ${job.status} already at ${short(headSha)}`;
        const to = await this.transition(job, 'pr_activity', { headSha });
        if (!to) return `ignored: job ${job.status} cannot take pr_activity`;
        return `job ${to} with PR #${prNumber}`;
    }

    /** The job's PR was merged or closed. */
    async prClosed(job: Job, prNumber: number, merged: boolean): Promise<string> {
        const event: JobEvent = merged ? 'merged' : 'closed';
        const wasPending = job.status === 'queued' || job.status === 'dispatched';
        const to = await this.transition(job, event, { mergeConflict: false });
        if (!to) return `ignored: job ${job.status} cannot take ${event}`;
        // Stamp the end of the job's last run so time-to-merge can be measured.
        const last = await this.findRun(job.id, null);
        if (last && !last.finishedAt) await this.runs.update({ id: last.id }, { finishedAt: new Date() });
        if (wasPending) {
            // The PR ended while a retry was queued or running: that run's work is moot.
            const run = await this.findRun(job.id, null);
            if (run) {
                const res = await this.runs.update({ id: run.id, status: In(['firing', 'fired']) }, { status: 'superseded' });
                if (res.affected === 1) {
                    this.logger.log(`Run ${run.id} of job ${job.id} superseded: PR #${prNumber} ${event} while job was ${job.status}`);
                    await this.agentRuns?.endLinked('job_runs', run.id, { outcome: 'skipped', reason: `PR #${prNumber} ${event} while the job was ${job.status}` });
                }
            }
        }
        await this.lessons?.onJobEnded(job.id, to);
        if (merged) await this.syncMergedBlocked(job.id);
        if (merged) await this.capture?.operatorActions(job);
        if (merged) await this.manifests?.refreshQuietly(job.repoId);
        if (merged) await this.capture?.featureReadiness(job.featureId);
        if (merged) await this.scout?.publish(job.projectId, { type: 'job_merged', jobId: job.id, repoId: job.repoId });
        return `job ${to} with PR #${prNumber}`;
    }

    /** A completed workflow run for the job's PR. The caller checks `isTrackedWorkflow` first. */
    async workflowCompleted(job: Job, prNumber: number, run: WorkflowRunInfo): Promise<string> {
        if (job.headSha !== run.headSha) {
            return `ignored: stale workflow_run ${short(run.headSha)} for PR #${prNumber}`;
        }
        const conclusion = run.conclusion ?? 'unknown';
        const passed = CI_OK.has(conclusion);
        if (this.gateWorkflows.has(run.name)) return this.gateCompleted(job, prNumber, passed);

        const to = passed
            ? await this.transition(job, 'ci_passed', {})
            : await this.retryOrParkJob(
                job,
                `CI ${conclusion} on ${short(run.headSha)}. Fix the failing checks on the existing branch.`,
            );
        if (!to) return `ignored: job ${job.status} cannot take ${passed ? 'ci_passed' : 'retry'}`;
        if (to === 'awaiting_review') await this.capture?.jobAwaitingReview(job);

        const jobRun = await this.findRun(job.id, null);
        if (jobRun) await this.runs.update({ id: jobRun.id }, { status: passed ? 'ci_passed' : 'ci_failed', ciConclusion: conclusion });
        return `job ${to} with PR #${prNumber}`;
    }

    /** Gates never retry or move the job; they only flag it for a human. */
    private async gateCompleted(job: Job, prNumber: number, passed: boolean): Promise<string> {
        const res = await this.jobs.update(
            { id: job.id },
            passed ? { needsApproval: false, approvalReason: null } : { needsApproval: true, approvalReason: APPROVAL_REASON },
        );
        if (!passed && res.affected === 1 && !TERMINAL.has(job.status)) await this.capture?.approvalNeeded(job, APPROVAL_REASON);
        return passed
            ? `gate passed: approval cleared for PR #${prNumber}`
            : `gate failed: job ${job.status} needs approval for PR #${prNumber}`;
    }

    /** Requeues the job on the existing PR while attempts are left, else parks it. PR, branch and head sha are kept. */
    async retryOrParkJob(job: Job, reason: string, cause: ParkCause = 'failure', kind: RunKind = 'attempt'): Promise<Job['status'] | null> {
        // A conflict-fix round uses no attempt, so it is always requeued; every other round is limited by maxAttempts.
        const project = kind === 'conflict_fix' ? null : await this.projects.findOneBy({ id: job.projectId });
        const event = kind === 'conflict_fix' ? 'retry' : retryOrPark(job.attempts, project?.maxAttempts ?? job.attempts);
        const to = await this.transition(job, event, {
            lastReason: reason,
            ...(event === 'retry' ? { queuedAt: new Date(), nextRoundKind: kind === 'conflict_fix' ? kind : null } : {}),
        });
        if (to) this.logger.log(`Job ${job.id} ${event} (attempt ${job.attempts}): ${reason}`);
        if (to === 'parked') await this.lessons?.onJobEnded(job.id, to, reason);
        if (to === 'parked') await this.capture?.jobParked(job, reason, cause);
        return to;
    }

    /** Sends a job with an open PR back to its agent (reviewer action). Throws 409 when the job cannot take it. */
    async sendBack(job: Job, reason: string): Promise<Job['status']> {
        if (job.prNumber === null || (job.status !== 'pr_open' && job.status !== 'awaiting_review')) {
            throw new ConflictException(`Cannot send back a job that is ${job.status}${job.prNumber === null ? ' without a PR' : ''}`);
        }
        const to = await this.retryOrParkJob(job, `Sent back by the reviewer: ${reason}`, 'sent_back');
        if (!to) throw new ConflictException('Job changed in the meantime, try again');
        return to;
    }

    /** `sendBack` for a job known by id only (the HTTP route); 404 for an unknown id. */
    async sendBackById(id: string, reason: string): Promise<Job['status']> {
        const job = await this.jobs.findOneBy({ id });
        if (!job) throw new NotFoundException('Job not found');
        return this.sendBack(job, reason);
    }

    findRun(jobId: string, runId: string | null): Promise<JobRun | null> {
        if (runId) {
            return this.runs.findOneBy({ id: runId, jobId }).then((run) => run ?? this.latestRun(jobId));
        }
        return this.latestRun(jobId);
    }

    private latestRun(jobId: string): Promise<JobRun | null> {
        return this.runs.findOne({ where: { jobId }, order: { attempt: 'DESC' } });
    }

    /** Applies the event through the state machine; the update only lands if the status is still what we read. */
    private async transition(job: Job, event: JobEvent, changes: Partial<Job>): Promise<Job['status'] | null> {
        const to = nextStatus(job.status, event);
        if (!to) return null;
        // Only retryOrParkJob queues a conflict-fix round; any other way into the queue is a normal attempt.
        const reset = to === 'queued' && changes.nextRoundKind === undefined ? { nextRoundKind: null } : {};
        const res = await this.jobs.update({ id: job.id, status: job.status }, { ...changes, ...reset, status: to });
        if (res.affected !== 1) {
            this.logger.warn(`Job ${job.id} changed concurrently; ignoring ${event}`);
            return null;
        }
        return to;
    }
}

const workflowNames = (raw: string | undefined, fallback: string) =>
    new Set((raw ?? fallback).split(',').map((n) => n.trim()).filter(Boolean));

const short = (sha: string) => sha.slice(0, 7);
