import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RepoModule } from '../repo/repo.module.js';
import { UserModule } from '../user/user.module.js';

import { ExecutorController } from './executor.controller.js';
import { Executor } from './executor.entity.js';
import { ExecutorMapper } from './executor.mapper.js';
import { ExecutorSecretService } from './executor-secret.service.js';
import { ExecutorService } from './executor.service.js';

@Module({
    imports: [
        PassportModule.register({}),
        TypeOrmModule.forFeature([Executor]),
        RepoModule,
        UserModule
    ],
    controllers: [
        ExecutorController
    ],
    providers: [
        ExecutorService,
        ExecutorSecretService,
        ExecutorMapper
    ],
    exports: [
        ExecutorService
    ]
})
export class ExecutorModule { }
