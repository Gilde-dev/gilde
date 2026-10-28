import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

import type { AuthUser } from './auth.dto.js';

/**
 * Opt-in guard for human-only routes: always verifies a real JWT, also when AUTH_ENABLED=false (where the global guard
 * lets everything through without a user). Pair it with UserService.requireVerifiedHuman in the service.
 */
@Injectable()
export class JwtHumanGuard extends AuthGuard('jwt') {
    canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
        if (req.user?.credential === 'jwt') return true;
        return super.canActivate(context);
    }
}
