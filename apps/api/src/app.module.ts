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
import { LessonModule } from './lesson/lesson.module.js';


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
    HealthModule,
    ProjectModule,
    RepoModule,
    RunModule,
    JobModule,
    DispatchModule,
    FeedbackModule,
    WebhookModule,
    ReconcileModule,
    MetricsModule,
    LessonModule,
  ],
})
export class AppModule { }
