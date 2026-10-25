import { Logger, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, RouterModule } from '@nestjs/core';
import { MastraModule } from '@mastra/nestjs';

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
import { SkillModule } from '../skill/skill.module.js';
import { SkillService } from '../skill/skill.service.js';
import { RepoWorkspaceService } from '../workspace/repo-workspace.service.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';

import { CopilotContextInterceptor } from './copilot-context.interceptor.js';
import { MEMORY_INFRASTRUCTURE } from '../memory/memory.tokens.js';
import type { MemoryInfrastructure } from '../memory/memory.infrastructure.js';

import { copilotConfig, type CopilotConfig } from './copilot.config.js';
import { CopilotController } from './copilot.controller.js';
import { createMastra, MASTRA_PREFIX } from './copilot.mastra.js';
import { COPILOT_CONFIG, COPILOT_MASTRA } from './copilot.tokens.js';
import { RepoContextService } from './repo-context.service.js';
import type { CopilotServices } from './copilot.tools.js';

/** Config and the Mastra instance, built in a provider so the tools receive the Nest services by injection. */
@Module({
    imports: [JobModule, FeatureModule, RevisionModule, DispatchModule, MetricsModule, LessonModule, SkillModule, ProjectModule, RepoModule, GitHubModule, WorkspaceModule],
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
            ) => {
                const services: CopilotServices = { jobs, features, revisions, dispatcher, metrics, lessons, skills, projects, repos, github, workspace };
                return createMastra(config, services, undefined, repoContext, memory);
            },
            inject: [COPILOT_CONFIG, JobService, FeatureService, RevisionService, DispatcherService, MetricsService, LessonService, SkillService, ProjectService, RepoService, GITHUB_PORT, RepoWorkspaceService, RepoContextService, MEMORY_INFRASTRUCTURE],
        },
    ],
    exports: [COPILOT_CONFIG, COPILOT_MASTRA],
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
