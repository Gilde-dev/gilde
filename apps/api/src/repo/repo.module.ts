import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectModule } from '../project/project.module.js';

import { Repo } from './repo.entity.js';
import { RepoMapper } from './repo.mapper.js';
import { RepoController } from './repo.controller.js';
import { RepoService } from './repo.service.js';


@Module({
    imports: [
        TypeOrmModule.forFeature([
            Repo
        ]),
        ProjectModule
    ],
    controllers: [
        RepoController
    ],
    providers: [
        RepoMapper,
        RepoService
    ],
    exports: [
        RepoService
    ]
})
export class RepoModule { }
