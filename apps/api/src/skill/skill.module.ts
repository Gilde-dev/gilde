import { Module } from '@nestjs/common';

import { GITHUB_PORT } from '../github/github.port.js';
import { GitHubModule } from '../github/github.module.js';
import { JobModule } from '../job/job.module.js';
import { ProjectModule } from '../project/project.module.js';
import { RepoModule } from '../repo/repo.module.js';

import { RepoSkillsReader } from './repo-skills.js';
import { SkillController } from './skill.controller.js';
import { SkillLibraryResolver } from './skill-library.resolver.js';
import { SkillPromoteService } from './skill-promote.service.js';
import { SkillService } from './skill.service.js';

@Module({
    imports: [ProjectModule, RepoModule, GitHubModule, JobModule],
    controllers: [SkillController],
    providers: [
        SkillService,
        SkillPromoteService,
        SkillLibraryResolver,
        { provide: RepoSkillsReader, useFactory: (github) => new RepoSkillsReader(github), inject: [GITHUB_PORT] },
    ],
    exports: [SkillLibraryResolver, SkillService],
})
export class SkillModule { }
