import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthUser } from './auth.dto.js';

/** The authenticated user of the request, or null when there is none (AUTH_ENABLED=false). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | null => {
    return ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>().user ?? null;
});
