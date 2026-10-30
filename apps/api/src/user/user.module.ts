import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserController } from './user.controller.js';
import { User } from './user.entity.js';
import { UserMapper } from './user.mapper.js';
import { UserService } from './user.service.js';

@Module({
    imports: [
        PassportModule.register({}),
        TypeOrmModule.forFeature([User])
    ],
    controllers: [UserController],
    providers: [
        UserService,
        UserMapper
    ],
    exports: [
        UserService,
        UserMapper
    ]
})
export class UserModule { }
