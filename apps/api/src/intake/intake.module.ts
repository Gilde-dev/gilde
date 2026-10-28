import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GitHubModule } from '../github/github.module.js';
import { ProjectModule } from '../project/project.module.js';
import { RepoModule } from '../repo/repo.module.js';
import { Repo } from '../repo/repo.entity.js';
import { UserModule } from '../user/user.module.js';

import { IntakeController } from './intake.controller.js';
import { IntakeItem } from './intake-item.entity.js';
import { IntakeRefineRun } from './intake-refine-run.entity.js';
import { IntakeRefineService } from './intake-refine.service.js';
import { IntakeMapper } from './intake.mapper.js';
import { IntakeService } from './intake.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([IntakeItem, IntakeRefineRun, Repo]),
        PassportModule.register({}),
        GitHubModule,
        ProjectModule,
        RepoModule,
        UserModule,
    ],
    controllers: [IntakeController],
    providers: [IntakeMapper, IntakeService, IntakeRefineService],
    exports: [IntakeService, IntakeRefineService],
})
export class IntakeModule { }
