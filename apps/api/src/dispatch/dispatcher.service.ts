import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';

import { ExecutionError } from '../execution/execution.error.js';
import { EXECUTION_PORT, type ExecutionPort, type ExecutionResult } from '../execution/execution.port.js';
import { ACTIVE, nextStatus, retryOrPark } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { RunService } from '../run/run.service.js';

@Injectable()
export class DispatcherService {
    private readonly logger = new Logger(DispatcherService.name);

    constructor(
        private readonly runService: RunService,
        @Inject(EXECUTION_PORT) private readonly execution: ExecutionPort,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @InjectRepository(Repo) private readonly repoRepository: Repository<Repo>,
        @InjectRepository(Project) private readonly projectRepository: Repository<Project>,
        @InjectRepository(JobRun) private readonly runRepository: Repository<JobRun>,
    ) { }

    @Cron(CronExpression.EVERY_MINUTE)
    async scheduled(): Promise<void> {
        try {
            await this.dispatch();
        } catch (e) {
            this.logger.error(`Dispatch failed: ${errorMessage(e)}`);
        }
    }

    /** Fires queued jobs where slots are free. Returns how many were fired. */
    async dispatch(): Promise<number> {
        const queued = await this.jobRepository.find({ where: { status: 'queued' }, select: { repoId: true } });
        const repoIds = [...new Set(queued.map((j) => j.repoId))];

        // Daily budget is per project and shared by its repos, so track what is left as we go.
        const budgets = new Map<string, number>();
        let fired = 0;

        for (const repoId of repoIds) {
            const repo = await this.repoRepository.findOneBy({ id: repoId });
            if (!repo || repo.paused || !repo.routineFireUrl || !repo.routineTokenEnv) continue;

            const project = await this.projectRepository.findOneBy({ id: repo.projectId });
            if (!project || project.paused) continue;

            if (!budgets.has(project.id)) budgets.set(project.id, await this.dailyBudget(project));
            const active = await this.jobRepository.count({ where: { repoId, status: In(ACTIVE) } });
            const slots = Math.min(repo.maxConcurrentJobs - active, budgets.get(project.id)!);
            if (slots <= 0) continue;

            const jobs = await this.jobRepository.find({
                where: { repoId, status: 'queued' },
                order: { queuedAt: 'ASC' },
                take: slots,
            });
            for (const job of jobs) {
                try {
                    if (await this.fireJob(job.id, repo, project)) {
                        fired++;
                        budgets.set(project.id, budgets.get(project.id)! - 1);
                    }
                } catch (e) {
                    this.logger.error(`Job ${job.id}: ${errorMessage(e)}`);
                }
            }
        }
        return fired;
    }

    private async dailyBudget(project: Project): Promise<number> {
        const now = new Date();
        const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const used = await this.runRepository.count({
            where: { projectId: project.id, createdAt: MoreThanOrEqual(midnight) },
        });
        return project.dailyRunLimit - used;
    }

    private async fireJob(jobId: string, repo: Repo, project: Project): Promise<boolean> {
        const to = nextStatus('queued', 'fire');
        if (!to) throw new Error('Job state machine does not allow firing a queued job');

        // Conditional claim: only one concurrent dispatcher can move the job out of queued.
        const claim = await this.jobRepository.update(
            { id: jobId, status: 'queued' },
            { status: to, attempts: () => 'attempts + 1' },
        );
        if (!claim.affected) return false;

        const job = await this.jobRepository.findOneByOrFail({ id: jobId });

        let runId: string | undefined;
        let session: ExecutionResult;
        try {
            const run = await this.runService.create({
                jobId, projectId: project.id, repoId: repo.id, attempt: job.attempts,
            });
            runId = run.id;
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
                },
            );
        } catch (e) {
            const message = errorMessage(e);
            let event: 'retry' | 'park' = 'park';
            if (e instanceof ExecutionError) {
                if (runId) await this.runService.markFailed(runId, message);
                if (e.retryable) event = retryOrPark(job.attempts, project.maxAttempts);
            }
            await this.failJob(jobId, event, message);
            return true;
        }
        // Outside the try: a bookkeeping failure must not park a job that did fire.
        await this.runService.markFired(runId, session);
        return true;
    }

    private async failJob(jobId: string, event: 'retry' | 'park', reason: string): Promise<void> {
        const to = nextStatus('dispatched', event);
        if (!to) throw new Error(`Job state machine does not allow ${event} from dispatched`);
        const changes: Partial<Job> = { status: to, lastReason: reason };
        if (to === 'queued') changes.queuedAt = new Date();
        await this.jobRepository.update({ id: jobId, status: 'dispatched' }, changes);
    }

}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
