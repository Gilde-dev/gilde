import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

import { ApiKeyService, isApiKeyToken } from '../api-key/api-key.service.js';
import { IS_PUBLIC_KEY } from '../common/public.decorator.js';

import { authEnabled } from './auth.config.js';

/** Global guard: every HTTP route needs a valid JWT or API key (`Bearer gk_...`) unless it is @Public() or AUTH_ENABLED=false. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(
        private readonly reflector: Reflector,
        private readonly apiKeys: ApiKeyService,
    ) {
        super();
    }

    canActivate(context: ExecutionContext) {
        if (context.getType() !== 'http') return true;
        if (!authEnabled()) return true;
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) return true;
        const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
        const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (token && isApiKeyToken(token)) return this.authenticateApiKey(req, token);
        return super.canActivate(context);
    }

    private async authenticateApiKey(req: { user?: unknown }, token: string): Promise<boolean> {
        const user = await this.apiKeys.authenticate(token);
        if (!user) throw new UnauthorizedException();
        req.user = user;
        return true;
    }
}
