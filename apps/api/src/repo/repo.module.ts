import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { GitHubModule } from '../github/github.module.js';
import { ProjectModule } from '../project/project.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';

import { GithubInstallation } from './github-installation.entity.js';
import { GithubInstallationService } from './github-installation.service.js';
import { Repo } from './repo.entity.js';
import { RepoMapper } from './repo.mapper.js';
import { RepoController } from './repo.controller.js';
import { RepoManifestService } from './repo-manifest.service.js';
import { RepoService } from './repo.service.js';


@Module({
    imports: [
        TypeOrmModule.forFeature([
            Repo,
            GithubInstallation
        ]),
        ProjectModule,
        GitHubModule,
        WorkspaceModule
    ],
    controllers: [
        RepoController
    ],
    providers: [
        RepoMapper,
        GithubInstallationService,
        RepoManifestService,
        RepoService
    ],
    exports: [
        GithubInstallationService,
        RepoManifestService,
        RepoService
    ]
})
export class RepoModule { }
