import { CallHandler, ExecutionContext, HttpStatus, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { RequestContextService } from '@mastra/nestjs';
import type { Request, Response } from 'express';
import { of, type Observable } from 'rxjs';

import type { AuthUser } from '../auth/auth.dto.js';

import type { CopilotConfig } from './copilot.config.js';
import { COPILOT_USER_KEY, copilotResourceId } from './copilot.context.js';
import { COPILOT_CONFIG } from './copilot.tokens.js';
import { MASTRA_PREFIX } from './copilot.mastra.js';

/**
 * Runs for every request, acts only on /api/v1/mastra/*. It runs after the global JwtAuthGuard, so
 * req.user is the authenticated user. It
 * - answers 503 when the co-pilot is not configured,
 * - puts the user and the memory resourceId (the user id) into the Mastra request context, overriding
 *   anything a client sent in the request body, so tools and memory are scoped per user on every Mastra route.
 */
@Injectable()
export class CopilotContextInterceptor implements NestInterceptor {
    constructor(
        @Inject(COPILOT_CONFIG) private readonly config: CopilotConfig,
        private readonly moduleRef: ModuleRef,
    ) { }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
        if (context.getType() !== 'http') return next.handle();
        const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
        if (req.path !== MASTRA_PREFIX && !req.path.startsWith(`${MASTRA_PREFIX}/`)) return next.handle();

        if (!this.config.enabled) {
            // Answered here, not thrown: Mastra's exception filter hides the message of every 5xx.
            context.switchToHttp().getResponse<Response>().status(HttpStatus.SERVICE_UNAVAILABLE).json({
                statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                error: 'Service Unavailable',
                message: `The co-pilot is not configured: ${this.config.reason}`,
            });
            return of(undefined);
        }

        const user = req.user ? { id: req.user.id, name: req.user.name, email: req.user.email } : null;
        const requestContext = await this.moduleRef.resolve(RequestContextService, ContextIdFactory.getByRequest(req), { strict: false });
        requestContext.requestContext.set(COPILOT_USER_KEY, user);
        requestContext.requestContext.set(MASTRA_RESOURCE_ID_KEY, copilotResourceId(user));
        return next.handle();
    }
}
