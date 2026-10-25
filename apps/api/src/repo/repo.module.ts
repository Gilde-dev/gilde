import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { GitHubModule } from '../github/github.module.js';
import { ProjectModule } from '../project/project.module.js';

import { Repo } from './repo.entity.js';
import { RepoMapper } from './repo.mapper.js';
import { RepoController } from './repo.controller.js';
import { RepoManifestService } from './repo-manifest.service.js';
import { RepoService } from './repo.service.js';


@Module({
    imports: [
        TypeOrmModule.forFeature([
            Repo
        ]),
        ProjectModule,
        GitHubModule
    ],
    controllers: [
        RepoController
    ],
    providers: [
        RepoMapper,
        RepoManifestService,
        RepoService
    ],
    exports: [
        RepoManifestService,
        RepoService
    ]
})
export class RepoModule { }
