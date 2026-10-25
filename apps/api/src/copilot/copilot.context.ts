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

/** Request-context key with the id of the project the user has selected in the UI (or undefined). */
export const COPILOT_PROJECT_KEY = 'gildeProjectId';

/**
 * Finds the selected project id in a CopilotKit/AG-UI request body: the page's readable context is a `context`
 * array of { description, value } where value is JSON like { projectId }. Never throws.
 */
export function extractProjectId(body: unknown, depth = 0): string | undefined {
    if (depth > 6 || typeof body !== 'object' || body === null) return undefined;
    const context = (body as { context?: unknown }).context;
    if (Array.isArray(context)) {
        for (const item of context) {
            const raw = (item as { value?: unknown } | null)?.value;
            let value: unknown = raw;
            if (typeof raw === 'string') {
                try { value = JSON.parse(raw); } catch { continue; }
            }
            const projectId = (value as { projectId?: unknown } | null)?.projectId;
            if (typeof projectId === 'string' && projectId) return projectId;
        }
    }
    for (const child of Object.values(body)) {
        const found = extractProjectId(child, depth + 1);
        if (found) return found;
    }
    return undefined;
}
