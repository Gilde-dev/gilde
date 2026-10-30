import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { CreateBotUserSchema, type CreateBotUserDto, type UserProfileDto } from './user.dto.js';
import { UserService } from './user.service.js';

@Controller('/v1/users')
export class UserController {
    constructor(private readonly users: UserService) { }

    /** Creates a bot user (verified humans only; API keys, bots and the scout are refused). The password is never returned. */
    @Post('bots')
    @UseGuards(JwtHumanGuard)
    createBot(
        @CurrentUser() user: AuthUser | null,
        @Body(new ZodValidationPipe(CreateBotUserSchema)) dto: CreateBotUserDto,
    ): Promise<UserProfileDto> {
        return this.users.createBot(user ?? undefined, dto);
    }
}
