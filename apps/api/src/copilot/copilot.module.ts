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
import { MetricsModule } from '../metrics/metrics.module.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ProjectModule } from '../project/project.module.js';
import { ProjectService } from '../project/project.service.js';
import { RepoModule } from '../repo/repo.module.js';
import { RepoService } from '../repo/repo.service.js';
import { RevisionModule } from '../revision/revision.module.js';
import { RevisionService } from '../revision/revision.service.js';
import { UserModule } from '../user/user.module.js';
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

import { UsageService } from '../usage/usage.service.js';
import { copilotConfig, type CopilotConfig } from './copilot.config.js';
import { CopilotController } from './copilot.controller.js';
import { createMastra, MASTRA_PREFIX, type ScoutSetup } from './copilot.mastra.js';
import { COPILOT_CONFIG, COPILOT_MASTRA, SCOUT_GATE, SCOUT_SETUP, SCOUT_SIGNALS, SCOUT_THREADS } from './copilot.tokens.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import { ScoutDispatchGate } from './scout-delivery-policy.js';
import { ScoutSignalReceipt } from './scout-signal-receipt.entity.js';
import { ScoutSignalService } from './scout-signal.service.js';
import { ScoutWakeDay } from './scout-wake-day.entity.js';
import { ScoutWakeBudgetService } from './scout-wake-budget.service.js';
import { ScoutWakeReader } from './scout-wake.reader.js';
import { resolveScoutSetup } from './verkenner.setup.js';
import { ScoutThreads } from './verkenner.threads.js';
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
    imports: [TypeOrmModule.forFeature([ScoutSignalReceipt, ScoutWakeDay]), JobModule, FeatureModule, RevisionModule, DispatchModule, MetricsModule, LessonModule, SkillModule, ProjectModule, RepoModule, GitHubModule, WorkspaceModule, HistoryModule, UserModule],
    providers: [
        RepoContextService,
        {
            provide: COPILOT_CONFIG,
            useFactory: (): CopilotConfig => {
                const config = copilotConfig();
                if (!config.enabled) {
                    new Logger('Copilot').warn(`Co-pilot disabled: ${config.reason}. Its routes answer 503.`);
                }
                return config;
            },
        },
        {
            // The scout is off unless SCOUT_ENABLED=true and everything it needs exists. Never throws: a problem is logged
            // (without secrets) and the API starts without the scout.
            provide: SCOUT_SETUP,
            useFactory: (users: UserService): Promise<ScoutSetup | null> => resolveScoutSetup(users),
            inject: [UserService],
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
            ) => {
                const services: CopilotServices = { jobs, features, revisions, dispatcher, metrics, lessons, skills, projects, repos, github, workspace, history };
                return createMastra(config, services, undefined, repoContext, memory, usage, scout && { ...scout, gate });
            },
            inject: [COPILOT_CONFIG, JobService, FeatureService, RevisionService, DispatcherService, MetricsService, LessonService, SkillService, ProjectService, RepoService, GITHUB_PORT, RepoWorkspaceService, RepoContextService, MEMORY_INFRASTRUCTURE, HistorySearchService, UsageService, SCOUT_SETUP, SCOUT_GATE],
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
            ): ScoutSignalService | null => {
                if (!scout || !threads) return null;
                const budget = new ScoutWakeBudgetService(days, { maxWakesPerDay: scout.config.maxWakesPerDay, summaryHourUtc: scout.config.summaryHourUtc });
                const service = new ScoutSignalService({
                    mastra, threads, receipts, budget, jobs, features, repos,
                    inbox: async () => (await memory.storage.getStore('notifications')) as never,
                    summaryHourUtc: scout.config.summaryHourUtc,
                });
                gate.bind({ now: () => budget.now(), summaryAt: (now) => service.summaryAt(now), allowSummary: (projectId) => service.allowSummary(projectId) });
                publisher.register(service.sink);
                return service;
            },
            inject: [SCOUT_SETUP, COPILOT_MASTRA, SCOUT_THREADS, SCOUT_GATE, ScoutSignalPublisher, MEMORY_INFRASTRUCTURE, getRepositoryToken(ScoutSignalReceipt), getRepositoryToken(ScoutWakeDay), JobService, FeatureService, RepoService],
        },
        ScoutWakeReader,
        ScoutLifecycle,
    ],
    exports: [COPILOT_CONFIG, COPILOT_MASTRA, SCOUT_SETUP, SCOUT_THREADS, SCOUT_SIGNALS, ScoutWakeReader],
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
