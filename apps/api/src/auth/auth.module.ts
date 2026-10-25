import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';

import { UserModule } from '../user/user.module.js';

import { jwtExpiresIn, jwtSecret } from './auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { JwtStrategy } from './jwt.strategy.js';
import { LocalStrategy } from './local.strategy.js';

@Module({
    imports: [
        UserModule,
        PassportModule.register({}),
        JwtModule.registerAsync({
            useFactory: () => ({
                secret: jwtSecret(),
                signOptions: { algorithm: 'HS256', expiresIn: jwtExpiresIn() as never },
                verifyOptions: { algorithms: ['HS256'] },
            }),
        }),
        // Not a global guard: only routes that use ThrottlerGuard (login) are throttled.
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 5 }]),
    ],
    controllers: [
        AuthController
    ],
    providers: [
        AuthService,
        LocalStrategy,
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
})
export class AuthModule { }
