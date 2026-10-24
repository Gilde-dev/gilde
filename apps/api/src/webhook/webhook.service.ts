import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TERMINAL, nextStatus, type JobEvent } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
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
    check_suite?: {
        conclusion: string | null;
        head_sha: string;
        app?: { slug?: string };
        pull_requests?: { number: number }[];
    };
}

const CI_OK = new Set(['success', 'neutral', 'skipped']);

@Injectable()
export class WebhookService {
    private readonly logger = new Logger(WebhookService.name);

    constructor(
        private readonly repoService: RepoService,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
    ) { }

    async handle(event: string | undefined, payload: WebhookPayload | undefined): Promise<string> {
        if (event !== 'pull_request' && event !== 'check_suite') return `ignored: event ${event ?? '(none)'}`;

        const fullName = payload?.repository?.full_name;
        if (!fullName) return 'ignored: no repository in payload';
        const repo = await this.repoService.findByFullName(fullName);
        if (!repo) return `ignored: unknown repo ${fullName}`;

        if (event === 'check_suite') return this.onCheckSuite(repo.id, payload!);
        return this.onPullRequest(repo.id, payload!);
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
        if (!job) return `ignored: PR #${pr.number} is not a known job PR`;
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
        const to = await this.transition(job, event, {});
        if (!to) return `ignored: job ${job.status} cannot take ${event}`;
        return `job ${to} with PR #${pr.number}`;
    }

    private async onCheckSuite(repoId: string, payload: WebhookPayload): Promise<string> {
        const suite = payload.check_suite;
        if (payload.action !== 'completed' || !suite) return `ignored: check_suite ${payload.action ?? '(no action)'}`;
        if (suite.app?.slug !== 'github-actions') return `ignored: check_suite from ${suite.app?.slug ?? '(unknown app)'}`;

        for (const { number } of suite.pull_requests ?? []) {
            const job = await this.findJobByPr(repoId, number);
            if (!job) continue;
            if (job.headSha !== suite.head_sha) {
                return `ignored: stale check_suite ${short(suite.head_sha)} for PR #${number}`;
            }
            const conclusion = suite.conclusion ?? 'unknown';
            const passed = CI_OK.has(conclusion);
            const to = passed
                ? await this.transition(job, 'ci_passed', {})
                : await this.transition(job, 'park', { lastReason: `CI ${conclusion} on ${short(suite.head_sha)}` });
            if (!to) return `ignored: job ${job.status} cannot take ${passed ? 'ci_passed' : 'park'}`;

            const run = await this.findRun(job.id, null);
            if (run) await this.runs.update({ id: run.id }, { status: passed ? 'ci_passed' : 'ci_failed', ciConclusion: conclusion });
            return `job ${to} with PR #${number}`;
        }
        return 'ignored: check_suite has no known job PR';
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

const short = (sha: string) => sha.slice(0, 7);
