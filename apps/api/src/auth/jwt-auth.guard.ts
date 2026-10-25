import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { IS_PUBLIC_KEY } from '../common/public.decorator.js';

import { authEnabled } from './auth.config.js';

/** Global guard: every HTTP route needs a valid JWT unless it is @Public() or AUTH_ENABLED=false. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(private readonly reflector: Reflector) {
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
        return super.canActivate(context);
    }
}
