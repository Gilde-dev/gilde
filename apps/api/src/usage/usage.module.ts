import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Job } from '../job/job.entity.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { JobRun } from '../run/run.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { Feature } from '../feature/feature.entity.js';

import { AgentAttributionService } from './agent-attribution.service.js';
import { AgentUsageService } from './agent-usage.service.js';
import { UsageController } from './usage.controller.js';
import { LlmUsage } from './usage.entity.js';
import { UsageService } from './usage.service.js';

/** Global so the co-pilot and the memory/history code can record usage without importing each other. */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([LlmUsage, AgentUsage, JobRun, Job, Repo, Feature])],
    controllers: [UsageController],
    providers: [UsageService, AgentAttributionService, AgentUsageService],
    exports: [UsageService, AgentUsageService],
})
export class UsageModule { }
