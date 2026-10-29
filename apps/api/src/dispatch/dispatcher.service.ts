import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository, type SelectQueryBuilder } from 'typeorm';

import { Executor } from '../executor/executor.entity.js';
import { ExecutorService } from '../executor/executor.service.js';
import { Feature } from '../feature/feature.entity.js';
import { ExecutionError } from '../execution/execution.error.js';
import { loadDownstreamContext } from '../execution/downstream.js';
import { selectJobLessons } from '../execution/job-lessons.js';
import { knowledgeContributions } from '../execution/job-knowledge.js';
import { buildJobPromptInput } from '../execution/job-payload.js';
import { promptTooLargeError } from '../execution/job-prompt.js';
import { EXECUTION_PORT, type ExecutionPort, type ExecutionResult, type PreparedPrompt } from '../execution/execution.port.js';
import type { RunKind } from '../run/run-status.js';
import { ACTIVE, nextStatus, retryOrPark } from '../job/job-state.js';
import { jobOwnerId } from '../job/job-owner.js';
import { User } from '../user/user.entity.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { HistorySearchService } from '../memory/history/history-search.service.js';
import { BudgetAlertService } from '../budget/budget-alert.service.js';
import type { BudgetBlocker, BudgetStatusDto } from '../budget/budget.dto.js';
import type { DispatchBudgetEvidence, DispatchReason, DispatchResult, DispatchStatus, RepoDispatchReport } from './dispatch.dto.js';
import { BudgetService } from '../budget/budget.service.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { JobRevision } from '../revision/revision.entity.js';
import { ProjectMcpKnowledgeService } from '../project-mcp/project-mcp-knowledge.service.js';
import { Repo } from '../repo/repo.entity.js';
import { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { RunContextService } from '../skill/run-context.service.js';
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
        private readonly executors: ExecutorService,
        @Optional() private readonly capture?: NotificationCaptureService,
        @Optional() private readonly runContext?: RunContextService,
        @Optional() private readonly knowledgeService?: ProjectMcpKnowledgeService,
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
        if (this.running) return { fired: 0, failed: 0, waitingOnExecutor: 0, repos: [] };
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
        let waitingOnExecutor = 0;
        // Executors whose fire was rejected as a configuration error in this pass; their owner's other jobs wait for the next one.
        const broken = new Set<string>();

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
                reason: 'none', detail: null, resetsAt: null, waitingOnDependencies, waitingOnRevisions, waitingOnExecutor: 0, budget: null,
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
                    // A job without a fitting executor of its owner waits: it takes no slot and blocks nobody.
                    const choice = await this.chooseExecutor(job, repo, broken);
                    if (!choice.executor) {
                        if (choice.reason) await this.markWaiting(job, choice.reason);
                        report.waitingOnExecutor++;
                        waitingOnExecutor++;
                        refill = true;
                        continue;
                    }
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
                        const outcome = await this.fireJob(job.id, repo, project, choice.executor);
                        if (outcome === 'skipped') { capacity--; continue; }
                        if (outcome === 'oversized') { attempted--; refill = true; continue; }
                        if (outcome === 'fired') { fired++; report.fired++; }
                        else failed++;
                        // Other executors of the owner (or the next pass) may still take the rest of the queue.
                        if (outcome === 'exhausted') refill = true;
                        capacity--;
                        budgets.set(project.id, budgets.get(project.id)! - 1);
                        // The executor's setup is wrong: its owner's other jobs wait for the next pass instead of failing the same way.
                        if (outcome === 'config_error') broken.add(choice.executor.id);
                        // The repo is now paused; don't fire its remaining jobs this pass.
                        if (outcome === 'repo_config_error') { stop = true; break; }
                    } catch (e) {
                        capacity--;
                        this.logger.error(`Job ${job.id}: ${errorMessage(e)}`);
                    }
                }
                if (!refill) break;
            }
        }
        this.logChanges(reports);
        return { fired, failed, waitingOnExecutor, repos: reports };
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
            const key = [r.reason, detail, r.waitingOnDependencies, r.waitingOnRevisions, r.waitingOnExecutor].join('|');
            const previousKey = this.lastKeys.get(r.repoId) ?? 'none||0|0|0';
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

    /**
     * The executor of the job's owner to fire on, or why there is none. Only the owner's executors are ever considered:
     * no fallback to another user's executor or to a repo-level routine. A null reason means: wait without saying anything new.
     */
    private async chooseExecutor(job: Job, repo: Repo, broken: ReadonlySet<string>): Promise<{ executor: Executor } | { executor: null; reason: string | null }> {
        const creator = job.createdById
            ? await this.jobRepository.manager.getRepository(User).findOne({ where: { id: job.createdById }, select: { id: true, isBot: true } })
            : null;
        const ownerId = jobOwnerId(job, creator?.isBot ?? false);
        if (!ownerId) return { executor: null, reason: NO_EXECUTOR };

        const serving = (await this.executors.listForDispatch(ownerId))
            .filter((e) => e.enabled && e.tokenLast4 !== null && e.repoIds.includes(repo.id));
        if (!serving.length) return { executor: null, reason: NO_EXECUTOR };

        const now = new Date();
        const usable = serving.filter((e) => !e.exhaustedUntil || e.exhaustedUntil <= now);
        if (!usable.length) {
            const soonest = Math.min(...serving.map((e) => e.exhaustedUntil!.getTime()));
            return { executor: null, reason: `${EXECUTOR_EXHAUSTED} until ${new Date(soonest).toISOString()}` };
        }
        const working = usable.filter((e) => !broken.has(e.id));
        if (!working.length) return { executor: null, reason: null };

        const midnight = startOfUtcDay(now);
        let busy = 0;
        let atLimit = 0;
        const free: { executor: Executor; inFlight: number }[] = [];
        for (const executor of working) {
            const inFlight = await this.runsInFlight(executor.id);
            if (inFlight >= executor.maxConcurrent) { busy++; continue; }
            if (executor.dailyRunLimit !== null && await this.runRepository.countBy({ executorId: executor.id, createdAt: MoreThanOrEqual(midnight) }) >= executor.dailyRunLimit) { atLimit++; continue; }
            free.push({ executor, inFlight });
        }
        if (!free.length) return { executor: null, reason: busy > 0 ? EXECUTOR_BUSY : EXECUTOR_LIMIT };
        free.sort((a, b) => a.inFlight - b.inFlight || a.executor.name.localeCompare(b.executor.name));
        return { executor: free[0].executor };
    }

    /** Runs that are still being executed: fired (or firing) for a job that is still dispatched. */
    private runsInFlight(executorId: string): Promise<number> {
        return this.runRepository.createQueryBuilder('run')
            .innerJoin(Job, 'job', 'job.id = run.jobId')
            .where('run.executorId = :executorId', { executorId })
            .andWhere('run.status IN (:...running)', { running: ['firing', 'fired'] })
            .andWhere("job.status = 'dispatched'")
            .getCount();
    }

    private async markWaiting(job: Job, reason: string): Promise<void> {
        if (job.waitingReason === reason) return;
        await this.jobRepository.update({ id: job.id, status: 'queued' }, { waitingReason: reason });
    }

    private async fireJob(jobId: string, repo: Repo, project: Project, executor: Executor): Promise<'fired' | 'failed' | 'skipped' | 'config_error' | 'repo_config_error' | 'oversized' | 'exhausted'> {
        const to = nextStatus('queued', 'fire');
        if (!to) throw new Error('Job state machine does not allow firing a queued job');

        const queued = await this.jobRepository.findOneBy({ id: jobId, status: 'queued' });
        if (!queued) return 'skipped';
        // A conflict-fix round continues the PR and uses no attempt.
        const kind: RunKind = queued.nextRoundKind === 'conflict_fix' && queued.prNumber !== null ? 'conflict_fix' : 'attempt';

        // Conditional claim: only one concurrent dispatcher can move the job out of queued.
        const claim = await this.jobRepository.update(
            { id: jobId, status: 'queued' },
            { status: to, waitingReason: null, ...(kind === 'attempt' ? { attempts: () => 'attempts + 1' } : {}) },
        );
        if (!claim.affected) return 'skipped';

        const job = await this.jobRepository.findOneByOrFail({ id: jobId });

        const feature = job.featureId ? await this.featureRepository.findOneBy({ id: job.featureId }) : null;

        // Optional context: never throws, so a retrieval problem cannot fail the run or cost an attempt.
        const lessons = await selectJobLessons(this.history, { ...job, stacks: repo.stacks });
        const knowledge = await this.knowledgeService?.collect(project.id, job) ?? null;
        const downstream = await loadDownstreamContext(this.jobRepository.manager, job);

        let runId: string | undefined;
        let session: ExecutionResult;
        try {
            // The prompt is sized with the run id it will carry, before any run row exists.
            const reserved = await this.reserveRun(job, kind);
            const { payload, context } = buildJobPromptInput(job, repo, feature, reserved.id, reserved.attempt, downstream, lessons, knowledge);
            const prompt = this.execution.prepare(payload, context);
            if (!prompt.fits) {
                await this.parkOversized(job, prompt, kind);
                return 'oversized';
            }
            runId = await this.startRun(job, project.id, repo.id, reserved, executor.id, kind);
            await this.recordContext(runId, repo);
            await this.recordKnowledge(runId, prompt);
            const token = await this.executors.revealToken(executor.id).catch(() => {
                throw new ExecutionError(`Executor "${executor.name}" token could not be read`, 'config');
            });
            session = await this.execution.fire(
                { fullName: repo.fullName, executorName: executor.name, fireUrl: executor.fireUrl, token },
                prompt,
            );
        } catch (e) {
            const message = errorMessage(e);
            if (e instanceof ExecutionError && e.kind === 'config' && !runId) {
                // The setup shared by all runs is wrong (the agent instructions could not be read), not an executor: pause the repo.
                await this.requeueWithoutAttempt(jobId, message, kind);
                await this.repoService.pauseWithReason(repo.id, message);
                this.logger.warn(`Repo ${repo.fullName} paused: ${message}`);
                return 'repo_config_error';
            }
            if (e instanceof ExecutionError && e.kind === 'config') {
                // Nothing is disabled automatically: the job is parked with the executor's name so its owner can fix the setup.
                if (runId) await this.runService.markFailed(runId, message);
                await this.failJob(job, 'park', message);
                this.logger.warn(`Executor "${executor.name}" rejected the fire for ${repo.fullName}: ${message}`);
                return 'config_error';
            }
            if (e instanceof ExecutionError && e.kind === 'executor_exhausted') {
                // The executor's account is out of capacity, not the job: give the attempt back and let another executor take it.
                if (runId) await this.runService.markFailed(runId, message);
                await this.requeueWithoutAttempt(jobId, message, kind);
                await this.exhaust(executor, e.resetAt);
                return 'exhausted';
            }
            let event: 'retry' | 'park' = 'park';
            if (runId) await this.runService.markFailed(runId, message);
            if (e instanceof ExecutionError && e.retryable && kind === 'attempt') event = retryOrPark(job.attempts, project.maxAttempts);
            await this.failJob(job, event, message);
            return 'failed';
        }
        // Outside the try: a bookkeeping failure must not park a job that did fire.
        await this.runService.markFired(runId, session);
        return 'fired';
    }

    /** What reached the prompt, after trimming. A failed write is only logged. */
    private async recordKnowledge(runId: string, prompt: PreparedPrompt): Promise<void> {
        try {
            const contributions = knowledgeContributions(prompt.payload.knowledge);
            if (contributions.length) await this.runService.recordKnowledge(runId, contributions);
        } catch (e) {
            this.logger.warn(`Run knowledge not stored: ${errorMessage(e)}`);
        }
    }

    /** Never blocks or fails a fire: the capture returns an error value, and a failed write is only logged. */
    private async recordContext(runId: string, repo: Repo): Promise<void> {
        if (!this.runContext) return;
        try {
            await this.runService.recordContext(runId, await this.runContext.capture(repo));
        } catch (e) {
            this.logger.warn(`Run context for ${repo.fullName} not stored: ${errorMessage(e)}`);
        }
    }

    /**
     * The id and number of the run this round will use: an earlier fire_failed run of the same round (runs are unique per
     * job and number) or a new id. A conflict-fix round has no attempt of its own, so run numbers count the attempts used plus
     * the conflict-fix runs so far. Nothing is written.
     */
    private async reserveRun(job: Job, kind: RunKind): Promise<{ id: string; reuse: boolean; attempt: number }> {
        const used = job.attempts + await this.runRepository.countBy({ jobId: job.id, kind: 'conflict_fix' });
        const previous = await this.runRepository.findOneBy({ jobId: job.id, attempt: used, status: 'fire_failed', kind });
        if (previous) return { id: previous.id, reuse: true, attempt: used };
        return { id: randomUUID(), reuse: false, attempt: kind === 'conflict_fix' ? used + 1 : used };
    }

    /**
     * Creates the run for this attempt. A config error gives the attempt back, so the next fire reuses
     * the earlier fire_failed run instead of creating a new one.
     */
    private async startRun(job: Job, projectId: string, repoId: string, reserved: { id: string; reuse: boolean; attempt: number }, executorId: string, kind: RunKind): Promise<string> {
        if (reserved.reuse) {
            await this.runRepository.update(
                { id: reserved.id },
                { status: 'firing', error: null, finishedAt: null, executorId },
            );
            return reserved.id;
        }
        const run = await this.runService.create({ id: reserved.id, jobId: job.id, projectId, repoId, attempt: reserved.attempt, executorId, kind });
        return run.id;
    }

    /**
     * The prompt does not fit after trimming, which is about this job only: park it, give the claim's attempt back and
     * leave the repo, the daily allowance and the other queued jobs alone. No run exists and nothing was sent.
     */
    private async parkOversized(job: Job, prompt: PreparedPrompt, kind: RunKind): Promise<void> {
        const reason = promptTooLargeError(prompt, job.id).message;
        const to = nextStatus('dispatched', 'park');
        if (!to) throw new Error('Job state machine does not allow park from dispatched');
        const res = await this.jobRepository.update(
            { id: job.id, status: 'dispatched' },
            { status: to, lastReason: reason, ...(kind === 'attempt' ? { attempts: () => 'attempts - 1' } : {}) },
        );
        if (res.affected === 1) {
            this.logger.warn(`Job ${job.id} parked: ${reason}`);
            await this.capture?.jobParked(job, reason, 'dispatch');
        }
    }

    /** Marks the executor exhausted and tells its owner once per exhaustion. Notification problems never change the outcome. */
    private async exhaust(executor: Executor, resetAt: Date | null): Promise<void> {
        const until = await this.executors.markExhausted(executor.id, resetAt);
        if (!until) return;
        this.logger.warn(`Executor "${executor.name}" is exhausted until ${until.toISOString()}`);
        const owner = await this.jobRepository.manager.getRepository(User).findOne({ where: { id: executor.ownerId }, select: { id: true, name: true } }).catch(() => null);
        await this.capture?.executorExhausted(executor, owner?.name ?? 'Its owner', until);
    }

    /** A config error says nothing about the job: back to the queue, and the claim's attempt is given back. */
    private async requeueWithoutAttempt(jobId: string, reason: string, kind: RunKind): Promise<void> {
        const to = nextStatus('dispatched', 'retry');
        if (!to) throw new Error('Job state machine does not allow retry from dispatched');
        await this.jobRepository.update(
            { id: jobId, status: 'dispatched' },
            { status: to, lastReason: reason, ...(kind === 'attempt' ? { attempts: () => 'attempts - 1' } : {}) },
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

const NO_EXECUTOR = 'no executor';
const EXECUTOR_BUSY = 'executor busy';
const EXECUTOR_LIMIT = 'executor limit reached';
const EXECUTOR_EXHAUSTED = 'executor exhausted';

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

/** One log line per repo state change; nothing while the state stays the same. */
export function describeRepo(r: RepoDispatchReport, previous: DispatchReason | undefined): string {
    let text: string;
    switch (r.reason) {
        case 'repo_paused': text = `repo paused${r.detail ? `: ${r.detail}` : ''}`; break;
        case 'project_paused': text = 'project paused'; break;
        case 'no_manifest': text = `no cached .gilde.json (${r.detail ?? 'not refreshed yet'})`; break;
        case 'no_slots': text = `no free slots (${r.detail})`; break;
        case 'daily_limit': text = `daily limit reached (${r.detail}, resets ${r.resetsAt?.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC)`; break;
        case 'budget': text = `stopped by estimated budget (${r.detail ?? 'unknown'})${r.resetsAt ? `, earliest recovery ${r.resetsAt.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC` : ''}`; break;
        default: text = previous && previous !== 'none' ? 'dispatching again' : 'dispatching';
    }
    const waiting: string[] = [];
    if (r.waitingOnDependencies > 0) waiting.push(`${r.waitingOnDependencies} waiting on dependencies`);
    if (r.waitingOnRevisions > 0) waiting.push(`${r.waitingOnRevisions} waiting on proposals`);
    if (r.waitingOnExecutor > 0) waiting.push(`${r.waitingOnExecutor} waiting on an executor`);
    return `${r.fullName}: ${text}${waiting.length ? `, ${waiting.join(', ')}` : ''}`;
}

function startOfUtcDay(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function nextUtcMidnight(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
