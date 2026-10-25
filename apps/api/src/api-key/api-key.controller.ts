import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { CreateApiKeySchema, type ApiKeyResponseDto, type CreateApiKeyDto, type CreatedApiKeyDto } from './api-key.dto.js';
import { ApiKeyService } from './api-key.service.js';

@Controller('/v1/api-keys')
export class ApiKeyController {
    constructor(private readonly apiKeys: ApiKeyService) { }

    @Post()
    create(
        @CurrentUser() user: AuthUser | null,
        @Body(new ZodValidationPipe(CreateApiKeySchema)) dto: CreateApiKeyDto,
    ): Promise<CreatedApiKeyDto> {
        return this.apiKeys.create(this.owner(user), dto);
    }

    @Get()
    list(@CurrentUser() user: AuthUser | null): Promise<ApiKeyResponseDto[]> {
        return this.apiKeys.list(this.owner(user));
    }

    @Delete(':id')
    @HttpCode(204)
    revoke(@CurrentUser() user: AuthUser | null, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
        return this.apiKeys.revoke(this.owner(user), id);
    }

    private owner(user: AuthUser | null): string {
        if (!user) throw new UnauthorizedException();
        return user.id;
    }
}
