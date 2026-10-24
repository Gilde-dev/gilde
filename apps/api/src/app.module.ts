import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { TypeOrmModule } from '@nestjs/typeorm';

import { HealthModule } from './health/health.module.js';
import { ProjectModule } from './project/project.module.js';
import { RepoModule } from './repo/repo.module.js';
import { JobModule } from './job/job.module.js';


export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'api',
    }),
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: 'db.sqlite',
      autoLoadEntities: true,
      synchronize: true,
    }),
    HealthModule,
    ProjectModule,
    RepoModule,
    JobModule
  ],
})
export class AppModule { }
