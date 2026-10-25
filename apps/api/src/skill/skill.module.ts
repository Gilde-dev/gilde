import { Module } from '@nestjs/common';

import { GitHubModule } from '../github/github.module.js';
import { ProjectModule } from '../project/project.module.js';
import { RepoModule } from '../repo/repo.module.js';

import { SkillController } from './skill.controller.js';
import { SkillLibraryResolver } from './skill-library.resolver.js';
import { SkillService } from './skill.service.js';

@Module({
    imports: [ProjectModule, RepoModule, GitHubModule],
    controllers: [SkillController],
    providers: [SkillService, SkillLibraryResolver],
})
export class SkillModule { }
