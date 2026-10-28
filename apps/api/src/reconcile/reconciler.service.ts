import { BadGatewayException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { GITHUB_PORT, type GitHubPort, type GitHubPull, type GitHubWorkflowRun } from '../github/github.port.js';
import { JobEventsService } from '../job/job-events.service.js';
import { TERMINAL } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';
import { Repo } from '../repo/repo.entity.js';
import type { JobSyncResultDto, ReconcileResult } from './reconcile.dto.js';
import { parsePrBody } from '../webhook/pr-body.js';


const WATCHED: Job['status'][] = ['dispatched', 'pr_open', 'awaiting_review'];

@Injectable()
export class ReconcilerService implements OnModuleInit {
    private readonly logger = new Logger(ReconcilerService.name);
    private running = false;
    private tail: Promise<void> = Promise.resolve();

    constructor(
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
        private readonly events: JobEventsService,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @InjectRepository(Project) private readonly projects: Repository<Project>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
    ) { }

    onModuleInit(): void {
        if (!this.github.isConfigured()) this.logger.log('GitHub is not configured; reconcile sweep is disabled');
    }

    @Cron(CronExpression.EVERY_5_MINUTES)
    async scheduled(): Promise<void> {
        try {
            await this.reconcile();
        } catch (e) {
            this.logger.error(`Reconcile failed: ${errorMessage(e)}`);
        }
    }

    /**
     * Recovers job state from GitHub for events whose webhook was missed. A pass that overlaps a running one returns
     * immediately; a pass that overlaps a per-job sync waits for it.
     */
    async reconcile(): Promise<ReconcileResult> {
        if (!this.github.isConfigured() || this.running) return { checked: 0, corrected: 0 };
        this.running = true;
        try {
            return await this.serialize(() => this.runPass());
        } finally {
            this.running = false;
        }
    }

    /** The same pass, strictly for the jobs of one project. Queues behind work in progress instead of skipping. 404 for an unknown project. */
    async reconcileProject(projectId: string): Promise<ReconcileResult> {
        if (!(await this.projects.existsBy({ id: projectId }))) throw new NotFoundException('Project not found');
        if (!this.github.isConfigured()) throw new BadGatewayException('GitHub is not configured; fix GitHub access, then retry');
        return this.serialize(() => this.runPass(projectId));
    }

    /**
     * Re-checks one job's PR on GitHub now, with the rules of the scheduled pass. Terminal jobs with a PR only get their CI
     * conclusion refreshed. All GitHub reads happen before anything is written, so a failed read changes nothing.
     */
    async syncJob(jobId: string): Promise<JobSyncResultDto> {
        return this.serialize(async () => {
            const job = await this.jobs.findOneBy({ id: jobId });
            if (!job) throw new NotFoundException('Job not found');
            const blocked = syncIneligibleReason(job);
            if (blocked) throw new ConflictException(blocked);
            const fullName = (await this.repos.findOneBy({ id: job.repoId }))?.fullName;
            if (!fullName) throw new ConflictException('The job\'s repo no longer exists');
            if (!this.github.isConfigured()) throw new BadGatewayException(`Cannot read ${fullName} on GitHub: GitHub is not configured; fix GitHub access, then retry`);
            try {
                const o = await this.reconcileJob(job, fullName, () => this.github.listRecentPulls(fullName), true);
                return {
                    jobId: job.id,
                    pr: o.pull ? { number: o.pull.number, state: o.pull.state, merged: o.pull.merged, headSha: o.pull.headSha } : null,
                    ciConclusion: o.ciConclusion,
                    before: o.before,
                    after: o.after,
                    changes: o.corrected ? o.reasons : [],
                };
            } catch (e) {
                if (e instanceof GitHubReadError) {
                    this.logger.warn(`Sync of job ${job.id} failed: ${e.message}`);
                    throw new BadGatewayException(e.message);
                }
                throw e;
            }
        });
    }

    /** Runs `fn` after everything queued before it, so passes and syncs never apply events at the same time. */
    private serialize<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.tail.then(fn, fn);
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }

    private async runPass(projectId?: string): Promise<ReconcileResult> {
        const scope = projectId ? { projectId } : {};
        const candidates = await this.jobs.find({ where: { ...scope, status: In(WATCHED) }, order: { queuedAt: 'ASC' } });
        const pending = await this.jobs.find({ where: { ...scope, status: 'queued' } });
        const all = [...candidates, ...pending.filter((j) => j.prNumber !== null)];

        const repoNames = new Map<string, string | null>();
        const recent = new Map<string, Promise<GitHubPull[]>>();
        const result: ReconcileResult = { checked: 0, corrected: 0 };

        for (const job of all) {
            result.checked++;
            try {
                if (!repoNames.has(job.repoId)) repoNames.set(job.repoId, (await this.repos.findOneBy({ id: job.repoId }))?.fullName ?? null);
                const fullName = repoNames.get(job.repoId);
                if (!fullName) continue;
                const outcome = await this.reconcileJob(job, fullName, () => {
                    if (!recent.has(fullName)) recent.set(fullName, this.github.listRecentPulls(fullName));
                    return recent.get(fullName)!;
                });
                if (outcome.corrected) result.corrected++;
            } catch (e) {
                this.logger.warn(`Reconcile of job ${job.id} failed: ${errorMessage(e)}`);
            }
        }
        return result;
    }

    /** The per-job implementation behind the pass and syncJob: read everything from GitHub first, then apply it. */
    private async reconcileJob(job: Job, fullName: string, recentPulls: () => Promise<GitHubPull[]>, byBranch = false): Promise<JobOutcome> {
        const before = snapshot(job);
        const observed = await this.observe(job, fullName, recentPulls, byBranch);
        const reasons: string[] = [];
        const { pull } = observed;
        const none = (): JobOutcome => ({ pull, ciConclusion: null, reasons, before, after: before, corrected: false });
        if (!pull) return none();

        if (TERMINAL.has(job.status)) return this.refreshCi(job, observed, before);

        let current: Job | null = job;
        if (job.prNumber === null) {
            // A PR found by branch may lack the marker; linkPr needs one to find the job.
            const body = parsePrBody(pull.body).jobId ? pull.body : `gilde-job: ${job.id}\n${pull.body ?? ''}`;
            await this.events.linkPr(job.repoId, { ...pull, body });
            reasons.push(`PR #${pull.number} ${byBranch ? 'found for the job' : 'carries the job marker'}`);
        }

        current = await this.reload(job);
        if (!current) return none();
        const prNumber = pull.number;

        if (pull.state === 'closed') {
            await this.events.prClosed(current, prNumber, pull.merged);
            reasons.push(`PR #${prNumber} ${pull.merged ? 'merged' : 'closed'}`);
        } else if (current.prNumber === prNumber && current.headSha !== pull.headSha) {
            await this.events.prUpdated(current, prNumber, pull.headSha);
            reasons.push(`PR #${prNumber} has new commits`);
        }

        current = await this.reload(job);
        if (current?.status === 'pr_open' && current.headSha && current.prNumber !== null && observed.runs && current.headSha === pull.headSha) {
            await this.applyWorkflowRuns(current, observed.runs, reasons);
        }

        current = await this.reload(job);
        const ciConclusion = observed.ciConclusion ?? (await this.latestRunConclusion(job.id));
        if (!current) return { pull, ciConclusion, reasons, before, after: before, corrected: false };
        const after = snapshot(current);
        const corrected = changed(before, after);
        if (corrected) {
            const reason = reasons.join('; ') || 'state differed from GitHub';
            this.logger.log(`reconciled job ${job.id}: ${before.status} → ${after.status} (${reason})`);
            if (!reasons.length) reasons.push(reason);
        }
        return { pull, ciConclusion, reasons, before, after, corrected };
    }

    /** Every GitHub read a job's reconciliation needs. Failures surface as GitHubReadError, before anything is written. */
    private async observe(job: Job, fullName: string, recentPulls: () => Promise<GitHubPull[]>, byBranch: boolean): Promise<Observed> {
        try {
            let pull: GitHubPull | null;
            if (job.prNumber === null) {
                const branch = job.branch ?? `claude/gilde-${job.id.slice(0, 8)}`;
                pull = (await recentPulls()).find((p) => {
                    const marker = parsePrBody(p.body).jobId;
                    return marker === job.id || (byBranch && !marker && p.headRef === branch);
                }) ?? null;
            } else {
                pull = await this.github.getPull(fullName, job.prNumber);
            }
            if (!pull) return { pull, runs: null, ciConclusion: null };
            const wantsRuns = TERMINAL.has(job.status)
                || (pull.state === 'open' && ((job.status !== 'awaiting_review' && job.status !== 'parked') || job.headSha !== pull.headSha));
            const runs = wantsRuns ? await this.github.listWorkflowRuns(fullName, pull.headSha) : null;
            return { pull, runs, ciConclusion: runs ? ciConclusionOf(runs, (n) => this.events.isTrackedWorkflow(n) && !this.events.isGateWorkflow(n)) : null };
        } catch (e) {
            throw new GitHubReadError(fullName, e);
        }
    }

    /** CI-only recheck of a merged or rejected job: stores the conclusion on its latest run and never touches the lifecycle. */
    private async refreshCi(job: Job, observed: Observed, before: Snapshot): Promise<JobOutcome> {
        const { pull, ciConclusion } = observed;
        const reasons: string[] = [];
        const run = await this.runs.findOne({ where: { jobId: job.id }, order: { attempt: 'DESC' } });
        let corrected = false;
        if (run && ciConclusion && run.ciConclusion !== ciConclusion && pull?.headSha === job.headSha) {
            await this.runs.update({ id: run.id }, { ciConclusion });
            reasons.push(`CI ${ciConclusion} recorded for the latest run`);
            corrected = true;
        }
        return { pull, ciConclusion: ciConclusion ?? run?.ciConclusion ?? null, reasons, before, after: before, corrected };
    }

    /** Feeds the newest completed run of every tracked workflow to the shared rules; gates first so CI moving the job doesn't hide them. */
    private async applyWorkflowRuns(job: Job, runs: GitHubWorkflowRun[], reasons: string[]): Promise<void> {
        const newest = new Map<string, GitHubWorkflowRun>();
        for (const run of runs) {
            if (run.status !== 'completed' || !this.events.isTrackedWorkflow(run.name)) continue;
            if (!newest.has(run.name)) newest.set(run.name, run);
        }
        const ordered = [...newest.values()].sort((a, b) => Number(this.events.isGateWorkflow(b.name)) - Number(this.events.isGateWorkflow(a.name)));

        for (const run of ordered) {
            const current = await this.reload(job);
            if (!current) return;
            await this.events.workflowCompleted(current, current.prNumber!, {
                name: run.name, conclusion: run.conclusion, headSha: current.headSha!,
            });
            reasons.push(`workflow ${run.name} ${run.conclusion ?? 'unknown'}`);
        }
    }

    private async latestRunConclusion(jobId: string): Promise<string | null> {
        return (await this.runs.findOne({ where: { jobId }, order: { attempt: 'DESC' } }))?.ciConclusion ?? null;
    }

    private reload(job: Job): Promise<Job | null> {
        return this.jobs.findOneBy({ id: job.id });
    }
}

/** Why a job cannot be synced (a 409 reason), or null when it can. */
export function syncIneligibleReason(job: Pick<Job, 'status' | 'prNumber'>): string | null {
    switch (job.status) {
        case 'dispatched': case 'pr_open': case 'awaiting_review':
            return null;
        case 'parked': case 'merged': case 'rejected':
            return job.prNumber === null ? `A ${job.status} job without a PR has nothing to check on GitHub` : null;
        default:
            return `A ${job.status} job has no PR to check on GitHub`;
    }
}

/** Raised for any failed GitHub read; the message names the repo and a reason and never carries tokens or response bodies. */
class GitHubReadError extends Error {
    constructor(fullName: string, cause: unknown) {
        super(`Cannot read ${fullName} on GitHub: ${reasonFor(cause)}`);
    }
}

function reasonFor(e: unknown): string {
    const msg = e instanceof Error ? e.message : '';
    if (/not installed/i.test(msg)) return 'the Gilde GitHub App is not installed on this repo; install it, then retry';
    if (/not configured/i.test(msg)) return 'GitHub is not configured; fix GitHub access, then retry';
    const status = /failed: (\d{3})/.exec(msg)?.[1];
    if (status === '401') return 'GitHub rejected the credentials (401); check the GitHub App private key or token';
    if (status === '403') return 'access denied or rate limited (403); check the GitHub App permissions, or retry later';
    if (status === '404') return 'not found (404); check that the GitHub App can access the repo';
    if (status === '429') return 'GitHub rate limit reached (429); retry later';
    if (status) return `GitHub answered ${status}; retry later`;
    return 'GitHub could not be reached; retry later';
}

interface Observed {
    pull: GitHubPull | null;
    runs: GitHubWorkflowRun[] | null;
    ciConclusion: string | null;
}

interface JobOutcome {
    pull: GitHubPull | null;
    ciConclusion: string | null;
    reasons: string[];
    before: Snapshot;
    after: Snapshot;
    corrected: boolean;
}

type Snapshot = ReturnType<typeof snapshot>;

/** The conclusion of the newest completed run among the workflows `include` accepts. */
function ciConclusionOf(runs: GitHubWorkflowRun[], include: (name: string) => boolean): string | null {
    return runs.find((r) => r.status === 'completed' && include(r.name))?.conclusion ?? null;
}

const snapshot = (j: Job) => ({
    status: j.status, prNumber: j.prNumber, headSha: j.headSha, needsApproval: j.needsApproval,
});
const changed = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) =>
    a.status !== b.status || a.prNumber !== b.prNumber || a.headSha !== b.headSha || a.needsApproval !== b.needsApproval;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
