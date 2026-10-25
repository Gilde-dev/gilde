import type { RequestContext } from '@mastra/core/request-context';

/** Request-context key that holds the authenticated Gilde user (or null) for tools. Set by CopilotContextInterceptor. */
export const COPILOT_USER_KEY = 'gildeUser';

export interface CopilotUser {
    id: string;
    name?: string;
    email?: string;
}

export function copilotUser(requestContext: Pick<RequestContext, 'get'> | undefined): CopilotUser | null {
    return (requestContext?.get(COPILOT_USER_KEY) as CopilotUser | null | undefined) ?? null;
}

/** Memory resource of a user: conversations are stored and read per user. */
export function copilotResourceId(user: CopilotUser | null): string {
    return user?.id ?? 'anonymous';
}
