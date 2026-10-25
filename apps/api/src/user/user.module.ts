import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from './user.entity.js';
import { UserMapper } from './user.mapper.js';
import { UserService } from './user.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([User])
    ],
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
