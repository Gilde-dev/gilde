import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TERMINAL, nextStatus, retryOrPark, type JobEvent } from '../job/job-state.js';
import { FeedbackService } from '../feedback/feedback.service.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { parsePrBody } from './pr-body.js';

interface PullRequestPayload {
    number: number;
    html_url: string;
    body: string | null;
    merged?: boolean;
    head: { ref: string; sha: string };
}

interface WebhookPayload {
    action?: string;
    repository?: { full_name?: string };
    pull_request?: PullRequestPayload;
    review?: {
        id?: number;
        html_url?: string;
        submitted_at?: string | null;
        state?: string;
        body?: string | null;
        author_association?: string;
        user?: { login?: string };
    };
    comment?: {
        id?: number;
        html_url?: string;
        created_at?: string;
        body?: string | null;
        author_association?: string;
        user?: { login?: string };
        pull_request_review_id?: number | null;
        path?: string;
        line?: number | null;
        original_line?: number | null;
    };
    issue?: { number: number; pull_request?: object };
    workflow_run?: {
        name?: string;
        conclusion: string | null;
        head_sha: string;
        pull_requests?: { number: number }[];
    };
}

// Reviewers whose feedback may send a job back to the agent.
const TRUSTED_REVIEWERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const HANDLED_EVENTS = new Set([
    'pull_request', 'check_suite', 'workflow_run', 'pull_request_review', 'pull_request_review_comment', 'issue_comment',
]);
const APPROVAL_REASON = 'Protected paths changed; add the gilde:allow-protected label if intended';
const CI_OK = new Set(['success', 'neutral', 'skipped']);

@Injectable()
export class WebhookService {
    private readonly logger = new Logger(WebhookService.name);
    private readonly ciWorkflows = workflowNames(process.env.GILDE_CI_WORKFLOWS, 'CI');
    private readonly gateWorkflows = workflowNames(process.env.GILDE_GATE_WORKFLOWS, 'Gates');

    constructor(
        private readonly repoService: RepoService,
        private readonly feedback: FeedbackService,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @InjectRepository(Project) private readonly projects: Repository<Project>,
    ) { }

    async handle(event: string | undefined, payload: WebhookPayload | undefined): Promise<string> {
        if (!HANDLED_EVENTS.has(event ?? '')) return `ignored: event ${event ?? '(none)'}`;

        const fullName = payload?.repository?.full_name;
        if (!fullName) return 'ignored: no repository in payload';
        const repo = await this.repoService.findByFullName(fullName);
        if (!repo) return `ignored: unknown repo ${fullName}`;

        if (event === 'check_suite') return 'ignored: check_suite deliveries are not used; decisions come from workflow_run';
        if (event === 'workflow_run') return this.onWorkflowRun(repo.id, payload!);
        if (event === 'pull_request_review') return this.onReview(repo.id, payload!);
        if (event === 'pull_request_review_comment') return this.onReviewComment(repo.id, payload!);
        if (event === 'issue_comment') return this.onIssueComment(repo.id, payload!);
        return this.onPullRequest(repo.id, payload!);
    }

    private async onReview(repoId: string, payload: WebhookPayload): Promise<string> {
        const { pull_request: pr, review } = payload;
        if (payload.action !== 'submitted' || !pr || !review) return `ignored: pull_request_review ${payload.action ?? '(no action)'}`;
        const job = await this.findJobByPr(repoId, pr.number);
        if (!job) return `ignored: PR #${pr.number} is not a known job PR`;
        const state = review.state?.toLowerCase() ?? null;
        if (review.id !== undefined) {
            await this.feedback.record({
                jobId: job.id, projectId: job.projectId, repoId, prNumber: pr.number, kind: 'review',
                githubId: String(review.id), author: review.user?.login ?? 'unknown',
                authorAssociation: review.author_association ?? 'NONE', state,
                reviewId: null, path: null, line: null, body: review.body ?? '',
                url: review.html_url ?? pr.html_url, createdAt: toDate(review.submitted_at),
            });
        }
        if (state !== 'changes_requested') return `ignored: review ${review.state ?? '(no state)'}`;
        if (!review.author_association || !TRUSTED_REVIEWERS.has(review.author_association)) {
            return `ignored: review by ${review.author_association ?? 'unknown'} reviewer`;
        }
        let reason = `Changes requested by @${review.user?.login ?? 'unknown'} on PR #${pr.number}:\n${review.body ?? ''}`;
        if (review.id !== undefined) {
            const inline = await this.feedback.findReviewComments(job.id, String(review.id));
            for (const c of inline) reason += `\n- ${c.path}:${c.line} ${c.body}`;
        }
        const result = await this.retryOrParkJob(job, reason);
        if (!result) return `ignored: job ${job.status} cannot take retry`;
        return `job ${result} with PR #${pr.number}`;
    }

    private async onReviewComment(repoId: string, payload: WebhookPayload): Promise<string> {
        const { pull_request: pr, comment } = payload;
        if (payload.action !== 'created' || !pr || comment?.id === undefined) return `ignored: pull_request_review_comment ${payload.action ?? '(no action)'}`;
        const job = await this.findJobByPr(repoId, pr.number);
        if (!job) return `ignored: PR #${pr.number} is not a known job PR`;
        const stored = await this.feedback.record({
            jobId: job.id, projectId: job.projectId, repoId, prNumber: pr.number, kind: 'review_comment',
            githubId: String(comment.id), author: comment.user?.login ?? 'unknown',
            authorAssociation: comment.author_association ?? 'NONE', state: null,
            reviewId: comment.pull_request_review_id != null ? String(comment.pull_request_review_id) : null,
            path: comment.path ?? null, line: comment.line ?? comment.original_line ?? null,
            body: comment.body ?? '', url: comment.html_url ?? pr.html_url, createdAt: toDate(comment.created_at),
        });
        return stored ? `stored review comment for PR #${pr.number}` : `unchanged: review comment ${comment.id} already stored`;
    }

    private async onIssueComment(repoId: string, payload: WebhookPayload): Promise<string> {
        const { issue, comment } = payload;
        if (payload.action !== 'created' || !issue || comment?.id === undefined) return `ignored: issue_comment ${payload.action ?? '(no action)'}`;
        if (!issue.pull_request) return `ignored: issue_comment on issue #${issue.number}`;
        const job = await this.findJobByPr(repoId, issue.number);
        if (!job) return `ignored: PR #${issue.number} is not a known job PR`;
        const stored = await this.feedback.record({
            jobId: job.id, projectId: job.projectId, repoId, prNumber: issue.number, kind: 'comment',
            githubId: String(comment.id), author: comment.user?.login ?? 'unknown',
            authorAssociation: comment.author_association ?? 'NONE', state: null, reviewId: null,
            path: null, line: null, body: comment.body ?? '', url: comment.html_url ?? job.prUrl ?? '',
            createdAt: toDate(comment.created_at),
        });
        return stored ? `stored comment for PR #${issue.number}` : `unchanged: comment ${comment.id} already stored`;
    }

    /** Requeues the job on the existing PR while attempts are left, else parks it. PR, branch and head sha are kept. */
    private async retryOrParkJob(job: Job, reason: string): Promise<Job['status'] | null> {
        const project = await this.projects.findOneBy({ id: job.projectId });
        const event = retryOrPark(job.attempts, project?.maxAttempts ?? job.attempts);
        const to = await this.transition(job, event, {
            lastReason: reason,
            ...(event === 'retry' ? { queuedAt: new Date() } : {}),
        });
        if (to) this.logger.log(`Job ${job.id} ${event} (attempt ${job.attempts}): ${reason}`);
        return to;
    }

    private async onPullRequest(repoId: string, payload: WebhookPayload): Promise<string> {
        const pr = payload.pull_request;
        if (!pr) return 'ignored: no pull_request in payload';
        switch (payload.action) {
            case 'opened':
            case 'reopened':
            case 'ready_for_review':
                return this.onOpened(repoId, pr);
            case 'synchronize':
                return this.onSynchronize(repoId, pr);
            case 'edited':
                return this.onEdited(repoId, pr);
            case 'closed':
                return this.onClosed(repoId, pr);
            default:
                return `ignored: pull_request ${payload.action ?? '(no action)'}`;
        }
    }

    private async onOpened(repoId: string, pr: PullRequestPayload): Promise<string> {
        const parsed = parsePrBody(pr.body);
        if (!parsed.jobId) return `ignored: PR #${pr.number} has no gilde-job marker`;
        const job = await this.jobs.findOneBy({ id: parsed.jobId, repoId });
        if (!job) return `ignored: PR #${pr.number} references unknown job`;
        if (TERMINAL.has(job.status)) return `ignored: job is ${job.status}`;
        if (job.prNumber !== null && job.prNumber !== pr.number) {
            return `ignored: job already has PR #${job.prNumber}`;
        }
        // Redelivery (or reopen without new commits): don't pull a job back from awaiting_review.
        if (job.prNumber === pr.number && job.headSha === pr.head.sha) {
            return `unchanged: job ${job.status} with PR #${pr.number}`;
        }

        const to = await this.transition(job, 'pr_activity', {
            prNumber: pr.number,
            prUrl: pr.html_url,
            branch: pr.head.ref,
            headSha: pr.head.sha,
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

    private async onSynchronize(repoId: string, pr: PullRequestPayload): Promise<string> {
        const job = await this.findJobByPr(repoId, pr.number);
        if (!job) return `ignored: PR #${pr.number} is not a known job PR`;
        if (job.headSha === pr.head.sha) return `unchanged: job ${job.status} already at ${short(pr.head.sha)}`;
        const to = await this.transition(job, 'pr_activity', { headSha: pr.head.sha });
        if (!to) return `ignored: job ${job.status} cannot take pr_activity`;
        return `job ${to} with PR #${pr.number}`;
    }

    private async onEdited(repoId: string, pr: PullRequestPayload): Promise<string> {
        const job = await this.findJobByPr(repoId, pr.number);
        // Not linked yet (e.g. opened before the gilde-job marker was added): link it like opened does.
        if (!job) return this.onOpened(repoId, pr);
        const run = await this.findRun(job.id, null);
        if (!run) return `ignored: job has no run`;
        const parsed = parsePrBody(pr.body);
        await this.runs.update(
            { id: run.id },
            { result: parsed.result, resultError: parsed.resultError, retro: parsed.retro },
        );
        return `updated result of run ${run.attempt} for PR #${pr.number}`;
    }

    private async onClosed(repoId: string, pr: PullRequestPayload): Promise<string> {
        const job = await this.findJobByPr(repoId, pr.number);
        if (!job) return `ignored: PR #${pr.number} is not a known job PR`;
        const event: JobEvent = pr.merged ? 'merged' : 'closed';
        const wasPending = job.status === 'queued' || job.status === 'dispatched';
        const to = await this.transition(job, event, {});
        if (!to) return `ignored: job ${job.status} cannot take ${event}`;
        if (wasPending) {
            // The PR ended while a retry was queued or running: that run's work is moot.
            const run = await this.findRun(job.id, null);
            if (run) {
                const res = await this.runs.update({ id: run.id, status: In(['firing', 'fired']) }, { status: 'superseded' });
                if (res.affected === 1) this.logger.log(`Run ${run.id} of job ${job.id} superseded: PR #${pr.number} ${event} while job was ${job.status}`);
            }
        }
        return `job ${to} with PR #${pr.number}`;
    }

    private async onWorkflowRun(repoId: string, payload: WebhookPayload): Promise<string> {
        const run = payload.workflow_run;
        if (payload.action !== 'completed' || !run) return `ignored: workflow_run ${payload.action ?? '(no action)'}`;
        const name = run.name ?? '';
        const isGate = this.gateWorkflows.has(name);
        if (!isGate && !this.ciWorkflows.has(name)) return `ignored: workflow ${name || '(unnamed)'} is not configured`;

        for (const { number } of run.pull_requests ?? []) {
            const job = await this.findJobByPr(repoId, number);
            if (!job) continue;
            if (job.headSha !== run.head_sha) {
                return `ignored: stale workflow_run ${short(run.head_sha)} for PR #${number}`;
            }
            const conclusion = run.conclusion ?? 'unknown';
            const passed = CI_OK.has(conclusion);
            if (isGate) return this.onGateRun(job, number, passed);

            const to = passed
                ? await this.transition(job, 'ci_passed', {})
                : await this.retryOrParkJob(
                    job,
                    `CI ${conclusion} on ${short(run.head_sha)}. Fix the failing checks on the existing branch.`,
                );
            if (!to) return `ignored: job ${job.status} cannot take ${passed ? 'ci_passed' : 'retry'}`;

            const jobRun = await this.findRun(job.id, null);
            if (jobRun) await this.runs.update({ id: jobRun.id }, { status: passed ? 'ci_passed' : 'ci_failed', ciConclusion: conclusion });
            return `job ${to} with PR #${number}`;
        }
        return 'ignored: workflow_run has no known job PR';
    }

    /** Gates never retry or move the job; they only flag it for a human. */
    private async onGateRun(job: Job, prNumber: number, passed: boolean): Promise<string> {
        await this.jobs.update(
            { id: job.id },
            passed ? { needsApproval: false, approvalReason: null } : { needsApproval: true, approvalReason: APPROVAL_REASON },
        );
        return passed
            ? `gate passed: approval cleared for PR #${prNumber}`
            : `gate failed: job ${job.status} needs approval for PR #${prNumber}`;
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

    private findJobByPr(repoId: string, prNumber: number): Promise<Job | null> {
        return this.jobs.findOneBy({ repoId, prNumber });
    }

    private async findRun(jobId: string, runId: string | null): Promise<JobRun | null> {
        if (runId) {
            const run = await this.runs.findOneBy({ id: runId, jobId });
            if (run) return run;
        }
        return this.runs.findOne({ where: { jobId }, order: { attempt: 'DESC' } });
    }
}

const workflowNames = (raw: string | undefined, fallback: string) =>
    new Set((raw ?? fallback).split(',').map((n) => n.trim()).filter(Boolean));

const short = (sha: string) => sha.slice(0, 7);

const toDate = (iso: string | null | undefined) => (iso ? new Date(iso) : new Date());
