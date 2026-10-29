import { Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_INTERCEPTOR, RouterModule } from '@nestjs/core';
import type { Mastra } from '@mastra/core/mastra';
import { MastraModule } from '@mastra/nestjs';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { DispatchModule } from '../dispatch/dispatch.module.js';
import { DispatcherService } from '../dispatch/dispatcher.service.js';
import { FeatureModule } from '../feature/feature.module.js';
import { FeatureService } from '../feature/feature.service.js';
import { GitHubModule } from '../github/github.module.js';
import { GITHUB_PORT, type GitHubPort } from '../github/github.port.js';
import { JobModule } from '../job/job.module.js';
import { JobService } from '../job/job.service.js';
import { LessonModule } from '../lesson/lesson.module.js';
import { LessonService } from '../lesson/lesson.service.js';
import { LessonPatternService } from '../lesson/lesson-pattern.service.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ProjectModule } from '../project/project.module.js';
import { ProjectService } from '../project/project.service.js';
import { RepoModule } from '../repo/repo.module.js';
import { RepoService } from '../repo/repo.service.js';
import { RunModule } from '../run/run.module.js';
import { RunService } from '../run/run.service.js';
import { DataSource } from 'typeorm';
import { RevisionModule } from '../revision/revision.module.js';
import { RevisionService } from '../revision/revision.service.js';
import { UserModule } from '../user/user.module.js';
import { SpecModule } from '../spec/spec.module.js';
import { ProjectMcpModule } from '../project-mcp/project-mcp.module.js';
import { ProjectMcpToolsService } from '../project-mcp/project-mcp-tools.service.js';
import { SpecService } from '../spec/spec.service.js';
import { FeaturePlanService } from './feature-plan.service.js';
import { UserService } from '../user/user.service.js';
import { SkillModule } from '../skill/skill.module.js';
import { SkillService } from '../skill/skill.service.js';
import { RepoWorkspaceService } from '../workspace/repo-workspace.service.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';

import { CopilotContextInterceptor } from './copilot-context.interceptor.js';
import { HistoryModule } from '../memory/history/history.module.js';
import { HistorySearchService } from '../memory/history/history-search.service.js';
import { MEMORY_INFRASTRUCTURE } from '../memory/memory.tokens.js';
import type { MemoryInfrastructure } from '../memory/memory.infrastructure.js';

import { AgentRunRecorder } from '../agent-run/agent-run.recorder.js';
import { UsageService } from '../usage/usage.service.js';
import { AGENTS_READY, AgentRuntimeService } from '../agent/agent-runtime.service.js';
import type { CopilotConfig } from './copilot.config.js';
import { extend, isOn, livePlanSetup, liveRefineSetup, liveScoutSetup } from './live-setups.js';
import { CopilotController } from './copilot.controller.js';
import { CopilotThreadsService } from './copilot-threads.service.js';
import { createMastra, MASTRA_PREFIX, type PlanSetup, type RefineSetup, type ScoutSetup } from './copilot.mastra.js';
import { COPILOT_CONFIG, COPILOT_MASTRA, PLAN_SETUP, PLAN_WORKER, REFINE_SETUP, REFINE_WORKER, SCOUT_GATE, SCOUT_SETUP, SCOUT_SIGNALS, SCOUT_THREADS } from './copilot.tokens.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import { ScoutDispatchGate } from './scout-delivery-policy.js';
import { ScoutSignalReceipt } from './scout-signal-receipt.entity.js';
import { BudgetModule } from '../budget/budget.module.js';
import { BudgetService } from '../budget/budget.service.js';
import { ScoutSignalService } from './scout-signal.service.js';
import { ScoutSuggestion } from './scout-suggestion.entity.js';
import { ScoutSuggestionGuard } from './scout-suggestion-guard.entity.js';
import { ScoutSuggestionService } from './scout-suggestion.service.js';
import { ScoutActivityService } from './scout-activity.service.js';
import { ScoutWakeDay } from './scout-wake-day.entity.js';
import { ScoutWakeBudgetService } from './scout-wake-budget.service.js';
import { ScoutWakeReader } from './scout-wake.reader.js';
import { ScoutThreads } from './verkenner.threads.js';
import { IntakeModule } from '../intake/intake.module.js';
import { IntakeCommentService } from '../intake/intake-comment.service.js';
import { IntakeRefineService } from '../intake/intake-refine.service.js';
import { RefinedSpecWriter } from './verfijner.save.js';
import { VerfijnerWorker } from './verfijner.worker.js';
import { PlanningWorker } from './planning.worker.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { NotificationModule } from '../notification/notification.module.js';
import { SpecPlanningService } from '../spec/spec-planning.service.js';
import { PlanProposer } from './werkmeester.propose.js';
import { WerkmeesterService } from './werkmeester.service.js';
import { RepoContextService } from './repo-context.service.js';
import type { CopilotServices } from './copilot.tools.js';

/**
 * Stops what the scout's notification dispatch started (its scheduler) when the API shuts down. Only when the scout is
 * on: without it nothing is scheduled, and the human co-pilot's shutdown behaviour stays as it was.
 */
@Injectable()
export class ScoutLifecycle implements OnModuleDestroy {
    constructor(
        @Inject(SCOUT_SETUP) private readonly scout: ScoutSetup | null,
        @Inject(COPILOT_MASTRA) private readonly mastra: Mastra,
    ) { }

    async onModuleDestroy(): Promise<void> {
        if (!this.scout) return;
        try {
            await this.mastra.shutdown();
        } catch (error) {
            new Logger('Verkenner').warn(`Shutting down the scout's Mastra instance failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }
}

/** Config and the Mastra instance, built in a provider so the tools receive the Nest services by injection. */
@Module({
    imports: [TypeOrmModule.forFeature([ScoutSignalReceipt, ScoutWakeDay, ScoutSuggestion, ScoutSuggestionGuard]), BudgetModule, JobModule, RunModule, FeatureModule, RevisionModule, DispatchModule, MetricsModule, LessonModule, SkillModule, ProjectModule, RepoModule, GitHubModule, WorkspaceModule, HistoryModule, UserModule, SpecModule, IntakeModule, ProjectMcpModule, NotificationModule],
    providers: [
        RepoContextService,
        FeaturePlanService,
        {
            // What the co-pilot agent is built from. The model and step limit are resolved per run from the settings in the
            // database (a restart is not needed to change them); only AGENTS_DISABLED, being environment, leaves it out.
            provide: COPILOT_CONFIG,
            useFactory: (runtime: AgentRuntimeService): CopilotConfig => {
                if (runtime.isDisabledByEnv('gilde')) {
                    new Logger('Copilot').warn('Co-pilot disabled by AGENTS_DISABLED. Its routes answer 503.');
                    return { enabled: false, model: null, reason: 'AGENTS_DISABLED names the co-pilot' };
                }
                const gilde = runtime.peek('gilde');
                return { enabled: true, model: gilde?.model ?? '', maxSteps: gilde?.settings.maxSteps, resolve: runtime.resolver('gilde') };
            },
            inject: [AgentRuntimeService, AGENTS_READY],
        },
        {
            // Live views of the bot agents: null only when AGENTS_DISABLED names the agent (environment, so fixed until a restart).
            // Whether an agent may run now, with which model and limits, is decided from the database per run and per tick.
            provide: SCOUT_SETUP,
            useFactory: (runtime: AgentRuntimeService): ScoutSetup | null => (runtime.isDisabledByEnv('verkenner') ? null : liveScoutSetup(runtime)),
            inject: [AgentRuntimeService, AGENTS_READY],
        },
        {
            provide: REFINE_SETUP,
            useFactory: (runtime: AgentRuntimeService): RefineSetup | null => (runtime.isDisabledByEnv('verfijner') ? null : liveRefineSetup(runtime)),
            inject: [AgentRuntimeService, AGENTS_READY],
        },
        {
            provide: PLAN_SETUP,
            useFactory: (runtime: AgentRuntimeService): PlanSetup | null => (runtime.isDisabledByEnv('werkmeester') ? null : livePlanSetup(runtime)),
            inject: [AgentRuntimeService, AGENTS_READY],
        },
        {
            // Null-safe: also constructed while the scout is off, where every suggestion is refused with scout_off.
            provide: ScoutSuggestionService,
            useFactory: (ds: DataSource, jobs: JobService, features: FeatureService, lessons: LessonService, runs: RunService, repos: RepoService, scout: ScoutSetup | null, patterns: LessonPatternService, projects: ProjectService, runtime: AgentRuntimeService) =>
                new ScoutSuggestionService(ds, jobs, features, lessons, runs, repos, scout && (() => (!scout.resolve || isOn(runtime, 'verkenner') ? { user: scout.user, dailySuggestions: scout.config.dailySuggestions, patternMinSize: scout.config.patternMinSize } : null)), undefined, patterns, projects),
            inject: [DataSource, JobService, FeatureService, LessonService, RunService, RepoService, SCOUT_SETUP, LessonPatternService, ProjectService, AgentRuntimeService],
        },
        {
            provide: ScoutActivityService,
            useFactory: (suggestions: Repository<ScoutSuggestion>, wakes: ScoutWakeReader, projects: ProjectService, users: UserService, runtime: AgentRuntimeService, setup: ScoutSetup | null) =>
                new ScoutActivityService(suggestions, wakes, projects, users, setup && !setup.resolve
                    // A fixed setup (tests) is reported as it is.
                    ? { enabled: true, model: setup.config.model, userId: setup.user.id, disabledReason: null }
                    : {
                        get enabled() { return isOn(runtime, 'verkenner'); },
                        get model() { const a = runtime.peek('verkenner'); return a?.status === 'on' ? a.effectiveModel : null; },
                        get userId() { return runtime.peek('verkenner')?.botUserId ?? null; },
                        get disabledReason() { const a = runtime.peek('verkenner'); return a && (a.status === 'misconfigured' || a.status === 'disabled_by_env') ? a.reason : null; },
                    }),
            inject: [getRepositoryToken(ScoutSuggestion), ScoutWakeReader, ProjectService, UserService, AgentRuntimeService, SCOUT_SETUP],
        },
        { provide: SCOUT_GATE, useFactory: (): ScoutDispatchGate => new ScoutDispatchGate() },
        {
            provide: COPILOT_MASTRA,
            useFactory: (
                config: CopilotConfig,
                jobs: JobService,
                features: FeatureService,
                revisions: RevisionService,
                dispatcher: DispatcherService,
                metrics: MetricsService,
                lessons: LessonService,
                lessonPatterns: LessonPatternService,
                skills: SkillService,
                projects: ProjectService,
                repos: RepoService,
                github: GitHubPort,
                workspace: RepoWorkspaceService,
                repoContext: RepoContextService,
                memory: MemoryInfrastructure,
                history: HistorySearchService,
                usage: UsageService,
                scout: ScoutSetup | null,
                gate: ScoutDispatchGate,
                suggestions: ScoutSuggestionService,
                specs: SpecService,
                plans: FeaturePlanService,
                refine: RefineSetup | null,
                refineItems: IntakeRefineService,
                mcpTools: ProjectMcpToolsService,
                plan: PlanSetup | null,
                runs: AgentRunRecorder,
            ) => {
                const services: CopilotServices = { jobs, features, revisions, dispatcher, metrics, lessons, lessonPatterns, skills, projects, repos, github, workspace, history, specs, plans, mcpTools };
                return createMastra(config, services, undefined, repoContext, memory, usage, scout && extend(scout, { gate, suggestions }), refine && extend(refine, { writer: new RefinedSpecWriter(specs, refineItems, refine.user) }), plan && extend(plan, { proposer: new PlanProposer(specs, plans) }), runs);
            },
            inject: [COPILOT_CONFIG, JobService, FeatureService, RevisionService, DispatcherService, MetricsService, LessonService, LessonPatternService, SkillService, ProjectService, RepoService, GITHUB_PORT, RepoWorkspaceService, RepoContextService, MEMORY_INFRASTRUCTURE, HistorySearchService, UsageService, SCOUT_SETUP, SCOUT_GATE, ScoutSuggestionService, SpecService, FeaturePlanService, REFINE_SETUP, IntakeRefineService, ProjectMcpToolsService, PLAN_SETUP, AgentRunRecorder],
        },
        {
            provide: SCOUT_THREADS,
            useFactory: (scout: ScoutSetup | null, mastra: Mastra, projects: ProjectService): ScoutThreads | null => (scout ? new ScoutThreads(mastra, scout.user, projects) : null),
            inject: [SCOUT_SETUP, COPILOT_MASTRA, ProjectService],
        },
        {
            // Publishes the six factory events into the scout's inbox. Null (and nothing registered) while the scout is off.
            provide: SCOUT_SIGNALS,
            useFactory: (
                scout: ScoutSetup | null,
                mastra: Mastra,
                threads: ScoutThreads | null,
                gate: ScoutDispatchGate,
                publisher: ScoutSignalPublisher,
                memory: MemoryInfrastructure,
                receipts: Repository<ScoutSignalReceipt>,
                days: Repository<ScoutWakeDay>,
                jobs: JobService,
                features: FeatureService,
                repos: RepoService,
                budgetService: BudgetService,
                runtime: AgentRuntimeService,
            ): ScoutSignalService | null => {
                if (!scout || !threads) return null;
                // Live: the limits and the summary hour are read at the moment of use.
                const budget = new ScoutWakeBudgetService(days, { get maxWakesPerDay() { return scout.config.maxWakesPerDay; }, get summaryHourUtc() { return scout.config.summaryHourUtc; } });
                const service = new ScoutSignalService({
                    mastra, threads, receipts, budget, jobs, features, repos,
                    inbox: async () => (await memory.storage.getStore('notifications')) as never,
                    get summaryHourUtc() { return scout.config.summaryHourUtc; },
                    globalBudgetHard: async () => {
                        const { global } = await budgetService.status();
                        return global.day.state === 'hard' || global.week.state === 'hard';
                    },
                });
                gate.bind({ now: () => budget.now(), summaryAt: (now) => service.summaryAt(now), allowSummary: (projectId) => service.allowSummary(projectId) });
                // While the scout is not on (switched off, misconfigured), events are dropped before they reach the inbox.
                publisher.register(async (projectId, event) => { if (!scout.resolve || isOn(runtime, 'verkenner')) await service.sink(projectId, event); });
                return service;
            },
            inject: [SCOUT_SETUP, COPILOT_MASTRA, SCOUT_THREADS, SCOUT_GATE, ScoutSignalPublisher, MEMORY_INFRASTRUCTURE, getRepositoryToken(ScoutSignalReceipt), getRepositoryToken(ScoutWakeDay), JobService, FeatureService, RepoService, BudgetService, AgentRuntimeService],
        },
        {
            // Null (and nothing scheduled) only when AGENTS_DISABLED names the Verfijner; otherwise it reads its setup on every tick.
            provide: REFINE_WORKER,
            useFactory: (refine: RefineSetup | null, mastra: Mastra, items: IntakeRefineService, budget: BudgetService, comments: IntakeCommentService, runtime: AgentRuntimeService, runs: AgentRunRecorder): VerfijnerWorker | null =>
                (refine ? new VerfijnerWorker(refine.resolve ? () => runtime.refineSetup() : refine, mastra, items, budget, comments, runs) : null),
            inject: [REFINE_SETUP, COPILOT_MASTRA, IntakeRefineService, BudgetService, IntakeCommentService, AgentRuntimeService, AgentRunRecorder],
        },
        {
            // Null (and nothing scheduled) only when AGENTS_DISABLED names the Werkmeester; otherwise it reads its setup on every tick and queued runs wait until it is on.
            provide: PLAN_WORKER,
            useFactory: (plan: PlanSetup | null, werkmeester: WerkmeesterService, planning: SpecPlanningService, budget: BudgetService, notifications: NotificationCaptureService, runtime: AgentRuntimeService, runs: AgentRunRecorder): PlanningWorker | null =>
                (plan ? new PlanningWorker(plan.resolve ? () => runtime.planSetup() : plan, werkmeester, planning, budget, notifications, runs) : null),
            inject: [PLAN_SETUP, WerkmeesterService, SpecPlanningService, BudgetService, NotificationCaptureService, AgentRuntimeService, AgentRunRecorder],
        },
        {
            // Always provided; reads the Werkmeester's setup for every binding and run, and plan() fails while it is not on.
            provide: WerkmeesterService,
            useFactory: (plan: PlanSetup | null, mastra: Mastra, specs: SpecService, repos: RepoService, runtime: AgentRuntimeService): WerkmeesterService => new WerkmeesterService(plan && (plan.resolve ? () => runtime.planSetup() : plan), mastra, specs, repos),
            inject: [PLAN_SETUP, COPILOT_MASTRA, SpecService, RepoService, AgentRuntimeService],
        },
        CopilotThreadsService,
        ScoutWakeReader,
        ScoutLifecycle,
    ],
    exports: [CopilotThreadsService, WerkmeesterService, COPILOT_CONFIG, COPILOT_MASTRA, PLAN_SETUP, PLAN_WORKER, REFINE_SETUP, REFINE_WORKER, SCOUT_SETUP, SCOUT_THREADS, SCOUT_SIGNALS, ScoutWakeReader, ScoutSuggestionService, ScoutActivityService],
})
export class CopilotCoreModule { }

@Module({
    imports: [
        CopilotCoreModule,
        MastraModule.registerAsync({
            imports: [CopilotCoreModule],
            inject: [COPILOT_MASTRA],
            useFactory: (mastra) => ({
                mastra,
                prefix: MASTRA_PREFIX,
                // Authentication is the global JwtAuthGuard, not Mastra's own.
                auth: { enabled: false },
            }),
        }),
        // Mount Mastra's catch-all controller under /api/v1/mastra so it cannot shadow other routes.
        RouterModule.register([{ path: 'v1/mastra', module: MastraModule }]),
    ],
    controllers: [CopilotController],
    providers: [{ provide: APP_INTERCEPTOR, useClass: CopilotContextInterceptor }],
})
export class CopilotModule { }
