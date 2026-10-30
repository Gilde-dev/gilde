import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserController } from './user.controller.js';
import { User } from './user.entity.js';
import { UserAudit } from './user-audit.entity.js';
import { UserSetupToken } from './user-setup-token.entity.js';
import { UserAdminService } from './user-admin.service.js';
import { UserMapper } from './user.mapper.js';
import { UserService } from './user.service.js';

@Module({
    imports: [
        PassportModule.register({}),
        TypeOrmModule.forFeature([User, UserSetupToken, UserAudit])
    ],
    controllers: [
        UserController
    ],
    providers: [
        UserService,
        UserAdminService,
        UserMapper
    ],
    exports: [
        UserService,
        UserAdminService,
        UserMapper
    ]
})
export class UserModule { }
