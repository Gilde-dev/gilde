import { CallHandler, ExecutionContext, HttpStatus, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { RequestContextService } from '@mastra/nestjs';
import type { Request, Response } from 'express';
import { of, type Observable } from 'rxjs';
import type { Mastra } from '@mastra/core/mastra';

import type { AuthUser } from '../auth/auth.dto.js';

import type { CopilotConfig } from './copilot.config.js';
import { COPILOT_USER_KEY, copilotResourceId, memoryReferences } from './copilot.context.js';
import { COPILOT_CONFIG, COPILOT_MASTRA } from './copilot.tokens.js';
import { MASTRA_PREFIX } from './copilot.mastra.js';

/**
 * Runs for every request, acts only on /api/v1/mastra/*. It runs after the global JwtAuthGuard, so
 * req.user is the authenticated user. It
 * - answers 503 when the co-pilot is not configured,
 * - answers 401 when there is no authenticated account (memory is never shared or anonymous),
 * - puts the user and the memory resourceId (the user id) into the Mastra request context, overriding
 *   anything a client sent in the request body, so tools and memory are scoped per user on every Mastra route,
 * - rejects requests that name another resource (403) or a thread/message of another user (404), and pins the
 *   resourceId query parameter of memory routes to the user.
 */
@Injectable()
export class CopilotContextInterceptor implements NestInterceptor {
    constructor(
        @Inject(COPILOT_CONFIG) private readonly config: CopilotConfig,
        @Inject(COPILOT_MASTRA) private readonly mastra: Mastra,
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

        if (!req.user?.id) {
            return this.reject(context, HttpStatus.UNAUTHORIZED, 'Unauthorized', 'The co-pilot needs an authenticated Gilde account');
        }
        const user = { id: req.user.id, name: req.user.name, email: req.user.email };

        const refs = memoryReferences(req.path, req.query, req.body);
        if (refs.resourceIds.some((id) => id !== user.id)) {
            return this.reject(context, HttpStatus.FORBIDDEN, 'Forbidden', 'Memory of another resource cannot be accessed');
        }
        if (!(await this.ownsAll(user.id, refs.threadIds, refs.messageIds))) {
            return this.reject(context, HttpStatus.NOT_FOUND, 'Not Found', 'Thread or message not found');
        }
        if (req.path.includes('/memory/')) {
            // Memory routes default to whatever resource the client names; pin it to the user.
            Object.defineProperty(req, 'query', { value: { ...req.query, resourceId: user.id }, configurable: true, writable: true });
        }

        const requestContext = await this.moduleRef.resolve(RequestContextService, ContextIdFactory.getByRequest(req), { strict: false });
        requestContext.requestContext.set(COPILOT_USER_KEY, user);
        requestContext.requestContext.set(MASTRA_RESOURCE_ID_KEY, copilotResourceId(user));
        return next.handle();
    }

    /** Threads and messages that exist must belong to the user; ones that do not exist yet will be created for the user. */
    private async ownsAll(userId: string, threadIds: string[], messageIds: string[]): Promise<boolean> {
        if (threadIds.length === 0 && messageIds.length === 0) return true;
        const store = await this.mastra.getStorage()?.getStore('memory');
        if (!store) return false;
        for (const threadId of new Set(threadIds)) {
            const thread = await store.getThreadById({ threadId });
            if (thread && thread.resourceId !== userId) return false;
        }
        if (messageIds.length > 0) {
            const { messages } = await store.listMessagesById({ messageIds });
            if (messages.some((m) => m.resourceId !== userId)) return false;
        }
        return true;
    }

    /** Answered here, not thrown: Mastra's exception filter hides the message of every 5xx. */
    private reject(context: ExecutionContext, status: HttpStatus, error: string, message: string): Observable<unknown> {
        context.switchToHttp().getResponse<Response>().status(status).json({ statusCode: status, error, message });
        return of(undefined);
    }
}
