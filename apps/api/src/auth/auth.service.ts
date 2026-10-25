import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

import type { UserResponseDto } from '../user/user.dto.js';
import { UserMapper } from '../user/user.mapper.js';
import { UserService, hashPassword } from '../user/user.service.js';

import type { JwtPayload, LoginResponseDto } from './auth.dto.js';

export const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
    /** Verified against when the email is unknown, so both failures take comparable time. */
    private dummyHash?: Promise<string>;

    constructor(
        private readonly users: UserService,
        private readonly mapper: UserMapper,
        private readonly jwt: JwtService,
    ) { }

    async validateCredentials(email: unknown, password: unknown): Promise<UserResponseDto> {
        if (typeof email !== 'string' || typeof password !== 'string' || password.length > 1024) {
            throw new UnauthorizedException(INVALID_CREDENTIALS);
        }
        const user = await this.users.findByEmailWithPassword(email);
        this.dummyHash ??= hashPassword(randomUUID());
        const hash = user?.password ?? await this.dummyHash;
        const valid = await argon2.verify(hash, password).catch(() => false);
        if (!user || !valid) throw new UnauthorizedException(INVALID_CREDENTIALS);
        return this.mapper.toDTO(user);
    }

    async login(user: UserResponseDto): Promise<LoginResponseDto> {
        const payload: JwtPayload = { sub: user.id, email: user.email, name: user.name };
        const accessToken = await this.jwt.signAsync(payload);
        const { iat, exp } = this.jwt.decode<{ iat: number; exp: number }>(accessToken);
        return { accessToken, expiresIn: exp - iat, user: { id: user.id, name: user.name, email: user.email } };
    }
}
