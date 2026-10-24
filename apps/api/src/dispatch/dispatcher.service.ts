import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository, type SelectQueryBuilder } from 'typeorm';

import { ExecutionError } from '../execution/execution.error.js';
import { EXECUTION_PORT, type ExecutionPort, type ExecutionResult } from '../execution/execution.port.js';
import { ACTIVE, nextStatus, retryOrPark } from '../job/job-state.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { RunService } from '../run/run.service.js';

@Injectable()
export class DispatcherService {
    private readonly logger = new Logger(DispatcherService.name);
    private running = false;

    constructor(
        private readonly runService: RunService,
        @Inject(EXECUTION_PORT) private readonly execution: ExecutionPort,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @InjectRepository(Repo) private readonly repoRepository: Repository<Repo>,
        @InjectRepository(Project) private readonly projectRepository: Repository<Project>,
        @InjectRepository(JobRun) private readonly runRepository: Repository<JobRun>,
        private readonly repoService: RepoService,
    ) { }

    @Cron(CronExpression.EVERY_MINUTE)
    async scheduled(): Promise<void> {
        try {
            await this.dispatch();
        } catch (e) {
            this.logger.error(`Dispatch failed: ${errorMessage(e)}`);
        }
    }

    /**
     * Fires queued jobs where slots are free. `fired` counts successful fires, `failed` fire attempts that failed.
     * A pass that starts while another is running in this process returns immediately.
     */
    async dispatch(): Promise<DispatchResult> {
        if (this.running) return { fired: 0, failed: 0 };
        this.running = true;
        try {
            return await this.runPass();
        } finally {
            this.running = false;
        }
    }

    private async runPass(): Promise<DispatchResult> {
        const queued = await this.jobRepository.find({ where: { status: 'queued' }, select: { repoId: true } });
        const repoIds = [...new Set(queued.map((j) => j.repoId))];

        // Daily budget is per project and shared by its repos, so track what is left as we go.
        const budgets = new Map<string, number>();
        let fired = 0;
        let failed = 0;

        for (const repoId of repoIds) {
            const repo = await this.repoRepository.findOneBy({ id: repoId });
            if (!repo || repo.paused || !repo.routineFireUrl || !repo.routineTokenEnv) continue;

            const project = await this.projectRepository.findOneBy({ id: repo.projectId });
            if (!project || project.paused) continue;

            // Jobs with an unmerged dependency are excluded in the query, so they take no slot and block nobody.
            const unmerged = (qb: SelectQueryBuilder<Job>) => qb.subQuery()
                .select('1')
                .from(JobDependency, 'd')
                .innerJoin(Job, 'dep', 'dep.id = d.dependsOnJobId')
                .where('d.jobId = job.id')
                .andWhere("dep.status <> 'merged'")
                .getQuery();
            const waiting = await this.jobRepository.createQueryBuilder('job')
                .where('job.repoId = :repoId', { repoId })
                .andWhere("job.status = 'queued'")
                .andWhere((qb) => `EXISTS ${unmerged(qb)}`)
                .getCount();
            if (waiting > 0) this.logger.log(`${repo.fullName}: ${waiting} queued job(s) waiting on dependencies`);

            if (!budgets.has(project.id)) budgets.set(project.id, await this.dailyBudget(project));
            const active = await this.jobRepository.count({ where: { repoId, status: In(ACTIVE) } });
            const slots = Math.min(repo.maxConcurrentJobs - active, budgets.get(project.id)!);
            if (slots <= 0) continue;

            const jobs = await this.jobRepository.createQueryBuilder('job')
                .where('job.repoId = :repoId', { repoId })
                .andWhere("job.status = 'queued'")
                .andWhere((qb) => `NOT EXISTS ${unmerged(qb)}`)
                .orderBy('job.queuedAt', 'ASC')
                .limit(slots)
                .getMany();
            for (const job of jobs) {
                try {
                    const outcome = await this.fireJob(job.id, repo, project);
                    if (outcome === 'skipped') continue;
                    if (outcome === 'fired') fired++;
                    else failed++;
                    budgets.set(project.id, budgets.get(project.id)! - 1);
                    // The repo is now paused; don't fire its remaining jobs this pass.
                    if (outcome === 'config_error') break;
                } catch (e) {
                    this.logger.error(`Job ${job.id}: ${errorMessage(e)}`);
                }
            }
        }
        return { fired, failed };
    }

    private async dailyBudget(project: Project): Promise<number> {
        const now = new Date();
        const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const used = await this.runRepository.count({
            where: { projectId: project.id, createdAt: MoreThanOrEqual(midnight) },
        });
        return project.dailyRunLimit - used;
    }

    private async fireJob(jobId: string, repo: Repo, project: Project): Promise<'fired' | 'failed' | 'skipped' | 'config_error'> {
        const to = nextStatus('queued', 'fire');
        if (!to) throw new Error('Job state machine does not allow firing a queued job');

        // Conditional claim: only one concurrent dispatcher can move the job out of queued.
        const claim = await this.jobRepository.update(
            { id: jobId, status: 'queued' },
            { status: to, attempts: () => 'attempts + 1' },
        );
        if (!claim.affected) return 'skipped';

        const job = await this.jobRepository.findOneByOrFail({ id: jobId });

        let runId: string | undefined;
        let session: ExecutionResult;
        try {
            runId = await this.startRun(job, project.id, repo.id);
            session = await this.execution.fire(
                { fullName: repo.fullName, routineFireUrl: repo.routineFireUrl, routineTokenEnv: repo.routineTokenEnv },
                {
                    gilde: 1,
                    jobId,
                    runId,
                    attempt: job.attempts,
                    repo: repo.fullName,
                    baseBranch: repo.defaultBranch,
                    title: job.title,
                    task: job.task,
                    acceptanceCriteria: job.acceptanceCriteria,
                    testCommand: repo.testCommand,
                    ...(job.prNumber !== null && job.branch
                        ? {
                            continueOn: {
                                branch: job.branch,
                                prNumber: job.prNumber,
                                reason: job.lastReason ?? 'Continue the work on this PR.',
                            },
                        }
                        : {}),
                },
            );
        } catch (e) {
            const message = errorMessage(e);
            if (e instanceof ExecutionError && e.kind === 'config') {
                if (runId) await this.runService.markFailed(runId, message);
                await this.requeueWithoutAttempt(jobId, message);
                await this.repoService.pauseWithReason(repo.id, message);
                this.logger.warn(`Repo ${repo.fullName} paused: ${message}`);
                return 'config_error';
            }
            let event: 'retry' | 'park' = 'park';
            if (runId) await this.runService.markFailed(runId, message);
            if (e instanceof ExecutionError && e.retryable) event = retryOrPark(job.attempts, project.maxAttempts);
            await this.failJob(jobId, event, message);
            return 'failed';
        }
        // Outside the try: a bookkeeping failure must not park a job that did fire.
        await this.runService.markFired(runId, session);
        return 'fired';
    }

    /**
     * Creates the run for this attempt. A config error gives the attempt back, so the next fire reuses
     * the earlier fire_failed run (runs are unique per job and attempt) instead of creating a new one.
     */
    private async startRun(job: Job, projectId: string, repoId: string): Promise<string> {
        const previous = await this.runRepository.findOneBy({ jobId: job.id, attempt: job.attempts, status: 'fire_failed' });
        if (previous) {
            await this.runRepository.update(
                { id: previous.id },
                { status: 'firing', error: null, finishedAt: null },
            );
            return previous.id;
        }
        const run = await this.runService.create({ jobId: job.id, projectId, repoId, attempt: job.attempts });
        return run.id;
    }

    /** A config error says nothing about the job: back to the queue, and the claim's attempt is given back. */
    private async requeueWithoutAttempt(jobId: string, reason: string): Promise<void> {
        const to = nextStatus('dispatched', 'retry');
        if (!to) throw new Error('Job state machine does not allow retry from dispatched');
        await this.jobRepository.update(
            { id: jobId, status: 'dispatched' },
            { status: to, lastReason: reason, attempts: () => 'attempts - 1' },
        );
    }

    private async failJob(jobId: string, event: 'retry' | 'park', reason: string): Promise<void> {
        const to = nextStatus('dispatched', event);
        if (!to) throw new Error(`Job state machine does not allow ${event} from dispatched`);
        const changes: Partial<Job> = { status: to, lastReason: reason };
        if (to === 'queued') changes.queuedAt = new Date();
        await this.jobRepository.update({ id: jobId, status: 'dispatched' }, changes);
    }

}

export interface DispatchResult {
    fired: number;
    failed: number;
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
