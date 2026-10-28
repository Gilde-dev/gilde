import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GITHUB_PORT } from '../github/github.port.js';
import { GitHubModule } from '../github/github.module.js';
import { Job } from '../job/job.entity.js';
import { JobModule } from '../job/job.module.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { ProjectModule } from '../project/project.module.js';
import { RepoModule } from '../repo/repo.module.js';
import { JobRevision } from '../revision/revision.entity.js';
import { JobRun } from '../run/run.entity.js';

import { RepoSkillsReader } from './repo-skills.js';
import { RunContextService } from './run-context.service.js';
import { SKILL_IMPACT_CONFIG, skillImpactConfig } from './skill-impact.config.js';
import { SkillImpactService } from './skill-impact.service.js';
import { SkillController } from './skill.controller.js';
import { SkillLibraryResolver } from './skill-library.resolver.js';
import { SkillPromoteService } from './skill-promote.service.js';
import { SkillService } from './skill.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Job, JobRun, JobRevision, AgentUsage]), ProjectModule, RepoModule, GitHubModule, JobModule],
    controllers: [SkillController],
    providers: [
        SkillService,
        SkillPromoteService,
        RunContextService,
        SkillImpactService,
        // Read once at startup: an invalid SKILL_IMPACT_MIN_RUNS stops the API instead of silently using a default.
        { provide: SKILL_IMPACT_CONFIG, useFactory: () => skillImpactConfig() },
        SkillLibraryResolver,
        { provide: RepoSkillsReader, useFactory: (github) => new RepoSkillsReader(github), inject: [GITHUB_PORT] },
    ],
    exports: [SkillLibraryResolver, SkillService, RunContextService],
})
export class SkillModule { }
