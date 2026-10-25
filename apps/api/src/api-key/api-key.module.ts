import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../user/user.entity.js';

import { ApiKeyController } from './api-key.controller.js';
import { ApiKey } from './api-key.entity.js';
import { ApiKeyMapper } from './api-key.mapper.js';
import { ApiKeyService } from './api-key.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([ApiKey, User])
    ],
    controllers: [
        ApiKeyController
    ],
    providers: [
        ApiKeyService,
        ApiKeyMapper
    ],
    exports: [
        ApiKeyService
    ]
})
export class ApiKeyModule { }
