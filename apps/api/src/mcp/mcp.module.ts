import { DynamicModule, Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DispatchModule } from '../dispatch/dispatch.module.js';
import { FeatureModule } from '../feature/feature.module.js';
import { GitHubModule } from '../github/github.module.js';
import { JobModule } from '../job/job.module.js';
import { LessonModule } from '../lesson/lesson.module.js';
import { HistoryModule } from '../memory/history/history.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ProjectModule } from '../project/project.module.js';
import { RepoModule } from '../repo/repo.module.js';
import { RevisionModule } from '../revision/revision.module.js';
import { SkillModule } from '../skill/skill.module.js';
import { SpecModule } from '../spec/spec.module.js';
import { UserModule } from '../user/user.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';
import { IntakeModule } from '../intake/intake.module.js';
import { FeaturePlanService } from '../copilot/feature-plan.service.js';

import { AgentRuntimeService } from '../agent/agent-runtime.service.js';
import { McpController } from './mcp.controller.js';
import { mcpConfig, type McpConfig } from './mcp.config.js';
import { McpService } from './mcp.service.js';
import { McpQuotaService } from './mcp-quota.service.js';
import { McpUsageDay } from './mcp-usage-day.entity.js';

export const MCP_CONFIG = Symbol('MCP_CONFIG');

/**
 * The MCP server for operators. The route exists only when MCP_ENABLED=true: otherwise the controller is not registered at
 * all and /api/v1/mcp is an ordinary 404, before and without any authentication, with no public-route exemption anywhere.
 * An invalid daily limit throws here, at startup. It needs no LLM and no co-pilot configuration.
 */
@Module({})
export class McpModule {
    static register(env: NodeJS.ProcessEnv = process.env): DynamicModule {
        const config = mcpConfig(env);
        if (config.enabled) new Logger('Mcp').log(`MCP server enabled at /api/v1/mcp (daily limits: ${config.dailyJobLimit} jobs, ${config.dailyFeatureLimit} features per user)`);
        return {
            module: McpModule,
            imports: [
                TypeOrmModule.forFeature([McpUsageDay]),
                UserModule, JobModule, FeatureModule, RevisionModule, DispatchModule, MetricsModule, LessonModule, SkillModule,
                ProjectModule, RepoModule, GitHubModule, WorkspaceModule, HistoryModule, SpecModule, IntakeModule,
            ],
            controllers: config.enabled ? [McpController] : [],
            providers: [
                { provide: MCP_CONFIG, useValue: config satisfies McpConfig },
                FeaturePlanService,
                {
                    provide: McpQuotaService,
                    // The daily limits are runtime settings of the MCP agent, read on every reservation (the env values are the fallback).
                    useFactory: (ds: DataSource, c: McpConfig, agents: AgentRuntimeService) => new McpQuotaService(ds, {
                        get dailyJobLimit() { return agents.peek('mcp')?.settings.dailyJobLimit ?? c.dailyJobLimit; },
                        get dailyFeatureLimit() { return agents.peek('mcp')?.settings.dailyFeatureLimit ?? c.dailyFeatureLimit; },
                    }),
                    inject: [DataSource, MCP_CONFIG, AgentRuntimeService],
                },
                McpService,
            ],
        };
    }
}
