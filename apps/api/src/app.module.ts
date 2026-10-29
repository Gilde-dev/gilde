import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { databaseConfig } from './database.config.js';
import { HealthModule } from './health/health.module.js';
import { ProjectModule } from './project/project.module.js';
import { RepoModule } from './repo/repo.module.js';
import { JobModule } from './job/job.module.js';
import { RunModule } from './run/run.module.js';
import { DispatchModule } from './dispatch/dispatch.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { WebhookModule } from './webhook/webhook.module.js';
import { ReconcileModule } from './reconcile/reconcile.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { FeatureModule } from './feature/feature.module.js';
import { LessonModule } from './lesson/lesson.module.js';
import { SkillModule } from './skill/skill.module.js';
import { RevisionModule } from './revision/revision.module.js';
import { UserModule } from './user/user.module.js';
import { ApiKeyModule } from './api-key/api-key.module.js';
import { ExecutorModule } from './executor/executor.module.js';
import { ProjectMcpModule } from './project-mcp/project-mcp.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CopilotModule } from './copilot/copilot.module.js';
import { MemoryModule } from './memory/memory.module.js';
import { HistoryModule } from './memory/history/history.module.js';
import { UsageModule } from './usage/usage.module.js';
import { AgentRunModule } from './agent-run/agent-run.module.js';
import { NotificationModule } from './notification/notification.module.js';
import { OtelModule } from './otel/otel.module.js';
import { BudgetModule } from './budget/budget.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { SpecModule } from './spec/spec.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { ScoutSignalModule } from './scout-signal/scout-signal.module.js';


export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'api',
    }),
    TypeOrmModule.forRoot(databaseConfig()),
    ScheduleModule.forRoot(),
    ScoutSignalModule,
    HealthModule,
    UsageModule,
    AgentRunModule,
    BudgetModule,
    MemoryModule,
    HistoryModule,
    ProjectModule,
    RepoModule,
    RunModule,
    JobModule,
    FeatureModule,
    SpecModule,
    IntakeModule,
    DispatchModule,
    FeedbackModule,
    WebhookModule,
    ReconcileModule,
    MetricsModule,
    LessonModule,
    SkillModule,
    RevisionModule,
    UserModule,
    ApiKeyModule,
    ExecutorModule,
    ProjectMcpModule,
    AuthModule,
    CopilotModule,
    McpModule.register(),
    NotificationModule,
    OtelModule,
  ],
})
export class AppModule { }
