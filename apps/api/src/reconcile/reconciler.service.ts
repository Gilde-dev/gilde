import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { GITHUB_PORT, type GitHubPort, type GitHubPull } from '../github/github.port.js';
import { JobEventsService } from '../job/job-events.service.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import type { ReconcileResult } from './reconcile.dto.js';
import { parsePrBody } from '../webhook/pr-body.js';


const WATCHED: Job['status'][] = ['dispatched', 'pr_open', 'awaiting_review'];

@Injectable()
export class ReconcilerService implements OnModuleInit {
    private readonly logger = new Logger(ReconcilerService.name);
    private running = false;

    constructor(
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
        private readonly events: JobEventsService,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
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

    /** Recovers job state from GitHub for events whose webhook was missed. A pass that overlaps a running one returns immediately. */
    async reconcile(): Promise<ReconcileResult> {
        if (!this.github.isConfigured() || this.running) return { checked: 0, corrected: 0 };
        this.running = true;
        try {
            return await this.runPass();
        } finally {
            this.running = false;
        }
    }

    private async runPass(): Promise<ReconcileResult> {
        const candidates = await this.jobs.find({ where: { status: In(WATCHED) }, order: { queuedAt: 'ASC' } });
        const pending = await this.jobs.find({ where: { status: 'queued' } });
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
                const reason = await this.reconcileJob(job, fullName, () => {
                    if (!recent.has(fullName)) recent.set(fullName, this.github.listRecentPulls(fullName));
                    return recent.get(fullName)!;
                });
                if (reason) result.corrected++;
            } catch (e) {
                this.logger.warn(`Reconcile of job ${job.id} failed: ${errorMessage(e)}`);
            }
        }
        return result;
    }

    /** Returns the reason when the job was corrected, else null. */
    private async reconcileJob(job: Job, fullName: string, recentPulls: () => Promise<GitHubPull[]>): Promise<string | null> {
        const reasons: string[] = [];
        const before = snapshot(job);
        let pull: GitHubPull | null = null;

        if (job.prNumber === null) {
            pull = (await recentPulls()).find((p) => parsePrBody(p.body).jobId === job.id) ?? null;
            if (!pull) return null;
            await this.events.linkPr(job.repoId, pull);
            reasons.push(`PR #${pull.number} carries the job marker`);
        } else {
            pull = await this.github.getPull(fullName, job.prNumber);
        }

        let current = await this.reload(job);
        if (!current) return null;
        const prNumber = pull.number;

        if (pull.state === 'closed') {
            await this.events.prClosed(current, prNumber, pull.merged);
            reasons.push(`PR #${prNumber} ${pull.merged ? 'merged' : 'closed'}`);
        } else if (current.prNumber === prNumber && current.headSha !== pull.headSha) {
            await this.events.prUpdated(current, prNumber, pull.headSha);
            reasons.push(`PR #${prNumber} has new commits`);
        }

        current = await this.reload(job);
        if (current?.status === 'pr_open' && current.headSha && current.prNumber !== null) {
            const ci = await this.applyWorkflowRuns(current, fullName, reasons);
            if (ci) current = ci;
        }

        current = await this.reload(job);
        if (!current || !changed(before, snapshot(current))) return null;
        const after = snapshot(current);
        const reason = reasons.join('; ') || 'state differed from GitHub';
        this.logger.log(`reconciled job ${job.id}: ${before.status} → ${after.status} (${reason})`);
        return reason;
    }

    /** Feeds the newest completed run of every tracked workflow to the shared rules; gates first so CI moving the job doesn't hide them. */
    private async applyWorkflowRuns(job: Job, fullName: string, reasons: string[]): Promise<Job | null> {
        const runs = await this.github.listWorkflowRuns(fullName, job.headSha!);
        const newest = new Map<string, (typeof runs)[number]>();
        for (const run of runs) {
            if (run.status !== 'completed' || !this.events.isTrackedWorkflow(run.name)) continue;
            if (!newest.has(run.name)) newest.set(run.name, run);
        }
        const ordered = [...newest.values()].sort((a, b) => Number(this.events.isGateWorkflow(b.name)) - Number(this.events.isGateWorkflow(a.name)));

        let current: Job | null = job;
        for (const run of ordered) {
            current = await this.reload(job);
            if (!current) return null;
            await this.events.workflowCompleted(current, current.prNumber!, {
                name: run.name, conclusion: run.conclusion, headSha: current.headSha!,
            });
            reasons.push(`workflow ${run.name} ${run.conclusion ?? 'unknown'}`);
        }
        return this.reload(job);
    }

    private reload(job: Job): Promise<Job | null> {
        return this.jobs.findOneBy({ id: job.id });
    }
}

const snapshot = (j: Job) => ({
    status: j.status, prNumber: j.prNumber, headSha: j.headSha, needsApproval: j.needsApproval,
});
const changed = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) =>
    a.status !== b.status || a.prNumber !== b.prNumber || a.headSha !== b.headSha || a.needsApproval !== b.needsApproval;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
