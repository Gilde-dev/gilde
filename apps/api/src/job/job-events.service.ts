import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TERMINAL, nextStatus, retryOrPark, type JobEvent } from './job-state.js';
import { Job } from './job.entity.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';
import { parsePrBody } from '../webhook/pr-body.js';

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
                { status: 'pr_opened', result: parsed.result, resultError: parsed.resultError, retro: parsed.retro },
            );
        }
        return `job ${to} with PR #${pr.number}`;
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
        const to = await this.transition(job, event, {});
        if (!to) return `ignored: job ${job.status} cannot take ${event}`;
        if (wasPending) {
            // The PR ended while a retry was queued or running: that run's work is moot.
            const run = await this.findRun(job.id, null);
            if (run) {
                const res = await this.runs.update({ id: run.id, status: In(['firing', 'fired']) }, { status: 'superseded' });
                if (res.affected === 1) this.logger.log(`Run ${run.id} of job ${job.id} superseded: PR #${prNumber} ${event} while job was ${job.status}`);
            }
        }
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

        const jobRun = await this.findRun(job.id, null);
        if (jobRun) await this.runs.update({ id: jobRun.id }, { status: passed ? 'ci_passed' : 'ci_failed', ciConclusion: conclusion });
        return `job ${to} with PR #${prNumber}`;
    }

    /** Gates never retry or move the job; they only flag it for a human. */
    private async gateCompleted(job: Job, prNumber: number, passed: boolean): Promise<string> {
        await this.jobs.update(
            { id: job.id },
            passed ? { needsApproval: false, approvalReason: null } : { needsApproval: true, approvalReason: APPROVAL_REASON },
        );
        return passed
            ? `gate passed: approval cleared for PR #${prNumber}`
            : `gate failed: job ${job.status} needs approval for PR #${prNumber}`;
    }

    /** Requeues the job on the existing PR while attempts are left, else parks it. PR, branch and head sha are kept. */
    async retryOrParkJob(job: Job, reason: string): Promise<Job['status'] | null> {
        const project = await this.projects.findOneBy({ id: job.projectId });
        const event = retryOrPark(job.attempts, project?.maxAttempts ?? job.attempts);
        const to = await this.transition(job, event, {
            lastReason: reason,
            ...(event === 'retry' ? { queuedAt: new Date() } : {}),
        });
        if (to) this.logger.log(`Job ${job.id} ${event} (attempt ${job.attempts}): ${reason}`);
        return to;
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
        const res = await this.jobs.update({ id: job.id, status: job.status }, { ...changes, status: to });
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
