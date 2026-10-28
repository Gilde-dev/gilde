import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository, type SelectQueryBuilder } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { ExecutionError } from '../execution/execution.error.js';
import { loadDownstreamContext } from '../execution/downstream.js';
import { selectJobLessons } from '../execution/job-lessons.js';
import { buildJobPromptInput } from '../execution/job-payload.js';
import { promptTooLargeError } from '../execution/job-prompt.js';
import { EXECUTION_PORT, type ExecutionPort, type ExecutionResult, type PreparedPrompt } from '../execution/execution.port.js';
import { ACTIVE, nextStatus, retryOrPark } from '../job/job-state.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { HistorySearchService } from '../memory/history/history-search.service.js';
import { BudgetAlertService } from '../budget/budget-alert.service.js';
import type { BudgetBlocker, BudgetStatusDto } from '../budget/budget.dto.js';
import { BudgetService } from '../budget/budget.service.js';
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
        private readonly budget: BudgetService,
        private readonly budgetAlerts: BudgetAlertService,
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

            // Jobs with an unmerged or merged-without-work dependency are excluded in the query, so they take no slot and block nobody.
            const unmerged = (qb: SelectQueryBuilder<Job>) => qb.subQuery()
                .select('1')
                .from(JobDependency, 'd')
                .innerJoin(Job, 'dep', 'dep.id = d.dependsOnJobId')
                .where('d.jobId = job.id')
                .andWhere("(dep.status <> 'merged' OR dep.mergedBlocked = :mergedBlocked)", { mergedBlocked: true })
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
                reason: 'none', detail: null, resetsAt: null, waitingOnDependencies, waitingOnRevisions, budget: null,
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
            // Estimated-spend guard: live recorded spend, evaluated for every repo of this pass.
            const blocked = await this.budgetBlock(project.id);
            if (blocked) {
                applyBudget(report, blocked);
                continue;
            }
            const slots = Math.min(repo.maxConcurrentJobs - active, budgets.get(project.id)!);

            // A job that cannot fit its prompt is parked without using a slot, so the batch is refilled for the others.
            const tried = new Set<string>();
            let capacity = slots;
            let attempted = 0;
            let stop = false;
            while (capacity > 0 && !stop) {
                const jobs = await queuedJobs()
                    .andWhere((qb) => `NOT EXISTS ${unmerged(qb)}`)
                    .andWhere((qb) => `NOT EXISTS ${revised(qb)}`)
                    .andWhere(tried.size ? 'job.id NOT IN (:...tried)' : '1 = 1', { tried: [...tried] })
                    .orderBy('job.queuedAt', 'ASC')
                    .limit(capacity)
                    .getMany();
                if (!jobs.length) break;
                let refill = false;
                for (const job of jobs) {
                    tried.add(job.id);
                    // The pre-check above covered the first fire; later ones see spend recorded since, not a stale answer.
                    if (attempted++ > 0) {
                        const stopped = await this.budgetBlock(project.id);
                        if (stopped) {
                            applyBudget(report, stopped);
                            stop = true;
                            break;
                        }
                    }
                    try {
                        const outcome = await this.fireJob(job.id, repo, project);
                        if (outcome === 'skipped') { capacity--; continue; }
                        if (outcome === 'oversized') { attempted--; refill = true; continue; }
                        if (outcome === 'fired') { fired++; report.fired++; }
                        else failed++;
                        capacity--;
                        budgets.set(project.id, budgets.get(project.id)! - 1);
                        // The repo is now paused; don't fire its remaining jobs this pass.
                        if (outcome === 'config_error') { stop = true; break; }
                    } catch (e) {
                        capacity--;
                        this.logger.error(`Job ${job.id}: ${errorMessage(e)}`);
                    }
                }
                if (!refill) break;
            }
        }
        this.logChanges(reports);
        return { fired, failed, repos: reports };
    }

    /**
     * Null when new automatic work may fire. Any evaluation error blocks (fail closed) and is reported as such, never as
     * a $0 status. Never mutates paused flags, runs or jobs; it only reads spend and records a hard notification.
     */
    private async budgetBlock(projectId: string): Promise<BudgetGate | null> {
        let status: BudgetStatusDto;
        try {
            status = await this.budget.status(projectId);
        } catch (e) {
            this.logger.error(`Budget evaluation failed, new automatic dispatch is stopped: ${errorMessage(e)}`);
            return { detail: 'budget could not be evaluated; new automatic dispatch is stopped', resetsAt: null, evidence: { blockers: [], recovery: 'unknown', error: true } };
        }
        if (!status.hardBlocked) return null;
        // Recording is best effort: a notification problem never overrides the stop decision.
        await this.budgetAlerts.capture(status).catch((e: unknown) => this.logger.error(`Recording the budget notification failed: ${errorMessage(e)}`));
        return {
            detail: status.blockers.map(describeBlocker).join('; '),
            resetsAt: status.recovery === 'reset' ? status.recoversAt : null,
            evidence: { blockers: status.blockers, recovery: status.recovery === 'none' ? 'manual' : status.recovery, error: false },
        };
    }

    private logChanges(reports: RepoDispatchReport[]): void {
        const seen = new Set<string>();
        for (const r of reports) {
            seen.add(r.repoId);
            const detail = r.reason === 'budget' ? (r.budget?.blockers.map((b) => `${b.scope}:${b.period}:${b.kind}`).join(',') ?? 'error') : r.detail;
            const key = [r.reason, detail, r.waitingOnDependencies, r.waitingOnRevisions].join('|');
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

    private async fireJob(jobId: string, repo: Repo, project: Project): Promise<'fired' | 'failed' | 'skipped' | 'config_error' | 'oversized'> {
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
        const downstream = await loadDownstreamContext(this.jobRepository.manager, job);

        let runId: string | undefined;
        let session: ExecutionResult;
        try {
            // The prompt is sized with the run id it will carry, before any run row exists.
            const reserved = await this.reserveRunId(job);
            const { payload, context } = buildJobPromptInput(job, repo, feature, reserved.id, job.attempts, downstream, lessons);
            const prompt = this.execution.prepare(payload, context);
            if (!prompt.fits) {
                await this.parkOversized(job, prompt);
                return 'oversized';
            }
            runId = await this.startRun(job, project.id, repo.id, reserved);
            session = await this.execution.fire(
                { fullName: repo.fullName, routineFireUrl: repo.routineFireUrl, routineTokenEnv: repo.routineTokenEnv },
                prompt,
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
     * The id of the run this attempt will use: an earlier fire_failed run of the same attempt (runs are unique per job and
     * attempt) or a new id. Nothing is written.
     */
    private async reserveRunId(job: Job): Promise<{ id: string; reuse: boolean }> {
        const previous = await this.runRepository.findOneBy({ jobId: job.id, attempt: job.attempts, status: 'fire_failed' });
        return previous ? { id: previous.id, reuse: true } : { id: randomUUID(), reuse: false };
    }

    /**
     * Creates the run for this attempt. A config error gives the attempt back, so the next fire reuses
     * the earlier fire_failed run instead of creating a new one.
     */
    private async startRun(job: Job, projectId: string, repoId: string, reserved: { id: string; reuse: boolean }): Promise<string> {
        if (reserved.reuse) {
            await this.runRepository.update(
                { id: reserved.id },
                { status: 'firing', error: null, finishedAt: null },
            );
            return reserved.id;
        }
        const run = await this.runService.create({ id: reserved.id, jobId: job.id, projectId, repoId, attempt: job.attempts });
        return run.id;
    }

    /**
     * The prompt does not fit after trimming, which is about this job only: park it, give the claim's attempt back and
     * leave the repo, the daily allowance and the other queued jobs alone. No run exists and nothing was sent.
     */
    private async parkOversized(job: Job, prompt: PreparedPrompt): Promise<void> {
        const reason = promptTooLargeError(prompt, job.id).message;
        const to = nextStatus('dispatched', 'park');
        if (!to) throw new Error('Job state machine does not allow park from dispatched');
        const res = await this.jobRepository.update(
            { id: job.id, status: 'dispatched' },
            { status: to, lastReason: reason, attempts: () => 'attempts - 1' },
        );
        if (res.affected === 1) {
            this.logger.warn(`Job ${job.id} parked: ${reason}`);
            await this.capture?.jobParked(job, reason, 'dispatch');
        }
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
    | 'repo_paused' | 'project_paused' | 'no_routine' | 'no_manifest' | 'no_slots' | 'daily_limit' | 'budget' | 'none';

/** Why the estimated-spend guard stopped a repo: every hard period at once, not only the first one found. */
export interface DispatchBudgetEvidence {
    /** Each hard project/global day/week period with scope, period, limit, spend and reset. */
    blockers: BudgetBlocker[];
    /** `reset`: the latest blocker reset is the earliest automatic recovery; `manual`: a limit/config change is needed; `unknown`: evaluation failed. */
    recovery: 'reset' | 'manual' | 'unknown';
    /** True when the budget could not be evaluated; new automatic dispatch stays stopped. */
    error: boolean;
}

interface BudgetGate { detail: string; resetsAt: string | null; evidence: DispatchBudgetEvidence }

function applyBudget(report: RepoDispatchReport, gate: BudgetGate): void {
    report.reason = 'budget';
    report.detail = gate.detail;
    report.resetsAt = gate.resetsAt;
    report.budget = gate.evidence;
}

function describeBlocker(b: BudgetBlocker): string {
    const name = `${b.scope} ${b.period}`;
    if (b.kind === 'configError') return `${name}: ${b.variable ?? 'budget variable'} is invalid`;
    const usd = (n: number) => `$${n.toFixed(2)}`;
    return `${name}: ${usd(b.spent)} of ${b.limit === null ? '–' : usd(b.limit)} estimated, resets ${b.resetsAt}`;
}

export interface RepoDispatchReport {
    repoId: string;
    fullName: string;
    queued: number;
    fired: number;
    reason: DispatchReason;
    /** pausedReason, manifestError, `active/max`, `used/limit` or the budget blockers; null otherwise. */
    detail: string | null;
    /**
     * Next UTC midnight (ISO) when the reason is daily_limit. For budget, the LATEST reset of all blockers (the earliest
     * automatic full recovery); null when a limit or configuration change is needed or the evaluation failed.
     */
    resetsAt: string | null;
    waitingOnDependencies: number;
    waitingOnRevisions: number;
    /** Set when the reason is budget. */
    budget: DispatchBudgetEvidence | null;
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
        case 'budget': text = `stopped by estimated budget (${r.detail ?? 'unknown'})${r.resetsAt ? `, earliest recovery ${r.resetsAt.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC` : ''}`; break;
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
