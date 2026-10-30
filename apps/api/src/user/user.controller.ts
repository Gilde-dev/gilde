import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { InviteUserSchema, SetAdminSchema, type AdminUserDto, type InviteUserDto, type SetAdminDto, type SetupLinkDto } from './user.dto.js';
import { UserAdminService } from './user-admin.service.js';

/** User management. Admins only (interactive JWT of an admin: no API keys, bots or non-admins). */
@Controller('/v1/users')
@UseGuards(JwtHumanGuard)
export class UserController {
    constructor(private readonly admin: UserAdminService) { }

    @Get()
    list(@CurrentUser() user: AuthUser | null): Promise<AdminUserDto[]> {
        return this.admin.list(user ?? undefined);
    }

    /** Creates a human user without a password; the response holds the one-time setup link. */
    @Post()
    invite(@CurrentUser() user: AuthUser | null, @Body(new ZodValidationPipe(InviteUserSchema)) dto: InviteUserDto): Promise<SetupLinkDto> {
        return this.admin.invite(user ?? undefined, dto);
    }

    @Post(':id/reset-link')
    resetLink(@CurrentUser() user: AuthUser | null, @Param('id', ParseUUIDPipe) id: string): Promise<SetupLinkDto> {
        return this.admin.resetLink(user ?? undefined, id);
    }

    @Post(':id/deactivate')
    @HttpCode(200)
    deactivate(@CurrentUser() user: AuthUser | null, @Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDto> {
        return this.admin.deactivate(user ?? undefined, id);
    }

    @Post(':id/reactivate')
    @HttpCode(200)
    reactivate(@CurrentUser() user: AuthUser | null, @Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDto> {
        return this.admin.reactivate(user ?? undefined, id);
    }

    @Put(':id/admin')
    setAdmin(@CurrentUser() user: AuthUser | null, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SetAdminSchema)) dto: SetAdminDto): Promise<AdminUserDto> {
        return this.admin.setAdmin(user ?? undefined, id, dto);
    }
}
