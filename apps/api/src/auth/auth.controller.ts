import { Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../common/public.decorator.js';
import type { UserResponseDto } from '../user/user.dto.js';
import { UserService } from '../user/user.service.js';

import type { AuthUser, LoginResponseDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { LocalAuthGuard } from './local-auth.guard.js';

@Controller('/v1/auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly users: UserService,
    ) { }

    @Public()
    @Post('login')
    @HttpCode(200)
    @UseGuards(ThrottlerGuard, LocalAuthGuard)
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    login(@Req() req: Request & { user: UserResponseDto }): Promise<LoginResponseDto> {
        return this.auth.login(req.user);
    }

    @Get('me')
    async me(@Req() req: Request & { user?: AuthUser }): Promise<UserResponseDto> {
        if (!req.user) throw new UnauthorizedException();
        try {
            return await this.users.getById(req.user.id);
        } catch {
            throw new UnauthorizedException();
        }
    }
}
