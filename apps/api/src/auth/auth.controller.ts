import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../common/public.decorator.js';
import { SetupPasswordSchema, type MeResponseDto, type SetupPasswordDto, type UserResponseDto } from '../user/user.dto.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
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

    /** Sets the password from a one-time setup or reset link and signs the user in. Invalid links all give the same 400. */
    @Public()
    @Post('setup')
    @HttpCode(200)
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    setup(@Body(new ZodValidationPipe(SetupPasswordSchema)) dto: SetupPasswordDto): Promise<LoginResponseDto> {
        return this.auth.setup(dto.token, dto.password);
    }

    @Get('me')
    async me(@Req() req: Request & { user?: AuthUser }): Promise<MeResponseDto> {
        if (!req.user) throw new UnauthorizedException();
        try {
            return await this.users.getMe(req.user.id);
        } catch {
            throw new UnauthorizedException();
        }
    }
}
