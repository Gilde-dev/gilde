import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository, type SelectQueryBuilder } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { ExecutionError } from '../execution/execution.error.js';
import { loadDownstream } from '../execution/downstream.js';
import { selectJobLessons } from '../execution/job-lessons.js';
import { buildJobPayload } from '../execution/job-payload.js';
import { EXECUTION_PORT, type ExecutionPort, type ExecutionResult } from '../execution/execution.port.js';
import { ACTIVE, nextStatus, retryOrPark } from '../job/job-state.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { HistorySearchService } from '../memory/history/history-search.service.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { JobRevision } from '../revision/revision.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { RunService } from '../run/run.service.js';

@Injectable()
export class DispatcherService {
    private readonly logger = new Logger(DispatcherService.name);
    private running = false;
    private last: DispatchStatus = { at: null, result: null };
    private readonly lastKeys = new Map<string, string>();
    private readonly lastReasons = new Map<string, DispatchReason>();

    constructor(
        private readonly runService: RunService,
        @Inject(EXECUTION_PORT) private readonly execution: ExecutionPort,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @InjectRepository(Repo) private readonly repoRepository: Repository<Repo>,
        @InjectRepository(Project) private readonly projectRepository: Repository<Project>,
        @InjectRepository(JobRun) private readonly runRepository: Repository<JobRun>,
        private readonly repoService: RepoService,
        @InjectRepository(Feature) private readonly featureRepository: Repository<Feature>,
        private readonly history: HistorySearchService,
        @Optional() private readonly capture?: NotificationCaptureService,
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
        if (this.running) return { fired: 0, failed: 0, repos: [] };
        this.running = true;
        try {
            const result = await this.runPass();
            this.last = { at: new Date().toISOString(), result };
            return result;
        } finally {
            this.running = false;
        }
    }

    /** The result of the last pass, without running one. */
    status(): DispatchStatus {
        return this.last;
    }

    private async runPass(): Promise<DispatchResult> {
        const queued = await this.jobRepository.find({ where: { status: 'queued' }, select: { repoId: true } });
        const repoIds = [...new Set(queued.map((j) => j.repoId))];

        // Daily budget is per project and shared by its repos, so track what is left as we go.
        const budgets = new Map<string, number>();
        let fired = 0;
        let failed = 0;

        const reports: RepoDispatchReport[] = [];
        for (const repoId of repoIds) {
            const repo = await this.repoRepository.findOneBy({ id: repoId });
            if (!repo) continue;
            const project = await this.projectRepository.findOneBy({ id: repo.projectId });

            // Jobs with an unmerged dependency are excluded in the query, so they take no slot and block nobody.
            const unmerged = (qb: SelectQueryBuilder<Job>) => qb.subQuery()
                .select('1')
                .from(JobDependency, 'd')
                .innerJoin(Job, 'dep', 'dep.id = d.dependsOnJobId')
                .where('d.jobId = job.id')
                .andWhere("dep.status <> 'merged'")
                .getQuery();
            // A job with a proposed revision waits for a human to accept or reject it.
            const revised = (qb: SelectQueryBuilder<Job>) => qb.subQuery()
                .select('1')
                .from(JobRevision, 'rev')
                .where('rev.jobId = job.id')
                .andWhere("rev.status = 'proposed'")
                .getQuery();
            const queuedJobs = () => this.jobRepository.createQueryBuilder('job')
                .where('job.repoId = :repoId', { repoId })
                .andWhere("job.status = 'queued'");
            const waitingOnDependencies = await queuedJobs().andWhere((qb) => `EXISTS ${unmerged(qb)}`).getCount();
            const waitingOnRevisions = await queuedJobs()
                .andWhere((qb) => `NOT EXISTS ${unmerged(qb)}`)
                .andWhere((qb) => `EXISTS ${revised(qb)}`)
                .getCount();

            const report: RepoDispatchReport = {
                repoId, fullName: repo.fullName, queued: await queuedJobs().getCount(), fired: 0,
                reason: 'none', detail: null, resetsAt: null, waitingOnDependencies, waitingOnRevisions,
            };
            reports.push(report);

            if (repo.paused) {
                report.reason = 'repo_paused';
                report.detail = repo.pausedReason;
                continue;
            }
            if (!project || project.paused) {
                report.reason = 'project_paused';
                continue;
            }
            if (!repo.routineFireUrl || !repo.routineTokenEnv) {
                report.reason = 'no_routine';
                continue;
            }
            if (repo.testCommands.length === 0) {
                report.reason = 'no_manifest';
                report.detail = repo.manifestError ?? 'not refreshed yet';
                continue;
            }

            if (!budgets.has(project.id)) budgets.set(project.id, await this.dailyBudget(project));
            const active = await this.jobRepository.count({ where: { repoId, status: In(ACTIVE) } });
            if (repo.maxConcurrentJobs - active <= 0) {
                report.reason = 'no_slots';
                report.detail = `${active}/${repo.maxConcurrentJobs}`;
                continue;
            }
            if (budgets.get(project.id)! <= 0) {
                report.reason = 'daily_limit';
                report.detail = `${project.dailyRunLimit}/${project.dailyRunLimit}`;
                report.resetsAt = nextUtcMidnight().toISOString();
                continue;
            }
            const slots = Math.min(repo.maxConcurrentJobs - active, budgets.get(project.id)!);

            const jobs = await queuedJobs()
                .andWhere((qb) => `NOT EXISTS ${unmerged(qb)}`)
                .andWhere((qb) => `NOT EXISTS ${revised(qb)}`)
                .orderBy('job.queuedAt', 'ASC')
                .limit(slots)
                .getMany();
            for (const job of jobs) {
                try {
                    const outcome = await this.fireJob(job.id, repo, project);
                    if (outcome === 'skipped') continue;
                    if (outcome === 'fired') { fired++; report.fired++; }
                    else failed++;
                    budgets.set(project.id, budgets.get(project.id)! - 1);
                    // The repo is now paused; don't fire its remaining jobs this pass.
                    if (outcome === 'config_error') break;
                } catch (e) {
                    this.logger.error(`Job ${job.id}: ${errorMessage(e)}`);
                }
            }
        }
        this.logChanges(reports);
        return { fired, failed, repos: reports };
    }

    private logChanges(reports: RepoDispatchReport[]): void {
        const seen = new Set<string>();
        for (const r of reports) {
            seen.add(r.repoId);
            const key = [r.reason, r.detail, r.waitingOnDependencies, r.waitingOnRevisions].join('|');
            const previousKey = this.lastKeys.get(r.repoId) ?? 'none||0|0';
            if (key === previousKey) continue;
            this.logger.log(describeRepo(r, this.lastReasons.get(r.repoId)));
            this.lastKeys.set(r.repoId, key);
            this.lastReasons.set(r.repoId, r.reason);
        }
        // A repo without queued jobs starts from a clean slate the next time it has some.
        for (const id of [...this.lastKeys.keys()]) {
            if (!seen.has(id)) { this.lastKeys.delete(id); this.lastReasons.delete(id); }
        }
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

        const feature = job.featureId ? await this.featureRepository.findOneBy({ id: job.featureId }) : null;

        // Optional context: never throws, so a retrieval problem cannot fail the run or cost an attempt.
        const lessons = await selectJobLessons(this.history, { ...job, stacks: repo.stacks });

        let runId: string | undefined;
        let session: ExecutionResult;
        try {
            runId = await this.startRun(job, project.id, repo.id);
            session = await this.execution.fire(
                { fullName: repo.fullName, routineFireUrl: repo.routineFireUrl, routineTokenEnv: repo.routineTokenEnv },
                buildJobPayload(job, repo, feature, runId, job.attempts, await loadDownstream(this.jobRepository.manager, job), lessons),
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
            await this.failJob(job, event, message);
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

    private async failJob(job: Job, event: 'retry' | 'park', reason: string): Promise<void> {
        const to = nextStatus('dispatched', event);
        if (!to) throw new Error(`Job state machine does not allow ${event} from dispatched`);
        const changes: Partial<Job> = { status: to, lastReason: reason };
        if (to === 'queued') changes.queuedAt = new Date();
        const res = await this.jobRepository.update({ id: job.id, status: 'dispatched' }, changes);
        if (res.affected === 1 && to === 'parked') await this.capture?.jobParked(job, reason, 'dispatch');
    }

}

export type DispatchReason =
    | 'repo_paused' | 'project_paused' | 'no_routine' | 'no_manifest' | 'no_slots' | 'daily_limit' | 'none';

export interface RepoDispatchReport {
    repoId: string;
    fullName: string;
    queued: number;
    fired: number;
    reason: DispatchReason;
    /** pausedReason, manifestError, `active/max` or `used/limit`; null otherwise. */
    detail: string | null;
    /** Next UTC midnight (ISO) when the reason is daily_limit; null otherwise. */
    resetsAt: string | null;
    waitingOnDependencies: number;
    waitingOnRevisions: number;
}

export interface DispatchResult {
    fired: number;
    failed: number;
    repos: RepoDispatchReport[];
}

export interface DispatchStatus {
    at: string | null;
    result: DispatchResult | null;
}

/** One log line per repo state change; nothing while the state stays the same. */
export function describeRepo(r: RepoDispatchReport, previous: DispatchReason | undefined): string {
    let text: string;
    switch (r.reason) {
        case 'repo_paused': text = `repo paused${r.detail ? `: ${r.detail}` : ''}`; break;
        case 'project_paused': text = 'project paused'; break;
        case 'no_routine': text = 'no routine configured'; break;
        case 'no_manifest': text = `no cached .gilde.json (${r.detail ?? 'not refreshed yet'})`; break;
        case 'no_slots': text = `no free slots (${r.detail})`; break;
        case 'daily_limit': text = `daily limit reached (${r.detail}, resets ${r.resetsAt?.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC)`; break;
        default: text = previous && previous !== 'none' ? 'dispatching again' : 'dispatching';
    }
    const waiting: string[] = [];
    if (r.waitingOnDependencies > 0) waiting.push(`${r.waitingOnDependencies} waiting on dependencies`);
    if (r.waitingOnRevisions > 0) waiting.push(`${r.waitingOnRevisions} waiting on proposals`);
    return `${r.fullName}: ${text}${waiting.length ? `, ${waiting.join(', ')}` : ''}`;
}

function nextUtcMidnight(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
