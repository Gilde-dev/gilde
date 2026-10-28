import type { RequestContext } from '@mastra/core/request-context';

/** Request-context key that holds the authenticated Gilde user (or null) for tools. Set by CopilotContextInterceptor. */
export const COPILOT_USER_KEY = 'gildeUser';

export interface CopilotUser {
    id: string;
    name?: string;
    email?: string;
    /** Provenance of the authenticated request, copied from req.user by the interceptor only. */
    credential?: 'jwt' | 'api_key';
}

export function copilotUser(requestContext: Pick<RequestContext, 'get'> | undefined): CopilotUser | null {
    return (requestContext?.get(COPILOT_USER_KEY) as CopilotUser | null | undefined) ?? null;
}

/** Placeholder default for routes that need a resourceId at registration; every request replaces it with the user id. */
export const UNAUTHENTICATED_RESOURCE = 'unauthenticated';

/**
 * Memory resource of a user: conversations, working memory and semantic recall are stored and read per user.
 * There is no shared fallback: without an authenticated account this throws.
 */
export function copilotResourceId(user: CopilotUser | null): string {
    if (!user?.id) throw new Error('Co-pilot memory needs an authenticated user');
    return user.id;
}

export interface MemoryReferences {
    resourceIds: string[];
    threadIds: string[];
    messageIds: string[];
}

const RESOURCE_KEYS = new Set(['resourceId', 'resource_id']);
const THREAD_KEYS = new Set(['threadId', 'thread_id']);
const MESSAGE_KEYS = new Set(['messageId', 'messageIds']);

/**
 * Every memory resource, thread and message id a Mastra request names: path (`/threads/:id`), query and JSON body
 * (including the AG-UI `threadId` and `memory: { resource, thread }` options). Used to check them against the caller.
 */
export function memoryReferences(path: string, query: unknown, body: unknown): MemoryReferences {
    const refs: MemoryReferences = { resourceIds: [], threadIds: [], messageIds: [] };
    const fromPath = /\/threads\/([^/?#]+)/.exec(path);
    if (fromPath) refs.threadIds.push(decodeURIComponent(fromPath[1]));
    const push = (list: string[], value: unknown) => {
        for (const v of Array.isArray(value) ? value : [value]) {
            if (typeof v === 'string' && v) list.push(v);
            else if (typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string') list.push((v as { id: string }).id);
        }
    };
    const walk = (node: unknown, depth: number) => {
        if (depth > 8 || typeof node !== 'object' || node === null) return;
        if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
        for (const [key, value] of Object.entries(node)) {
            if (RESOURCE_KEYS.has(key)) push(refs.resourceIds, value);
            else if (THREAD_KEYS.has(key)) push(refs.threadIds, value);
            else if (MESSAGE_KEYS.has(key)) push(refs.messageIds, value);
            else if (key === 'memory' && typeof value === 'object' && value !== null) {
                push(refs.resourceIds, (value as { resource?: unknown }).resource);
                push(refs.threadIds, (value as { thread?: unknown }).thread);
            }
            walk(value, depth + 1);
        }
    };
    walk(query, 0);
    walk(body, 0);
    return refs;
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

const AGENT_KEYS = new Set(['agentId', 'agent_id', 'agentName', 'agent']);

/**
 * Every agent id a Mastra request names: path (`/agents/:id/...`), query and JSON body (including the AG-UI
 * `params.agentId`). Used to keep internal agents (the scout) from being run or inspected over HTTP.
 */
export function agentReferences(path: string, query: unknown, body: unknown): string[] {
    const refs: string[] = [];
    const fromPath = /\/agents\/([^/?#]+)/.exec(path);
    if (fromPath) refs.push(decodeURIComponent(fromPath[1]));
    const walk = (node: unknown, depth: number) => {
        if (depth > 8 || typeof node !== 'object' || node === null) return;
        if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
        for (const [key, value] of Object.entries(node)) {
            if (AGENT_KEYS.has(key)) {
                for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string') refs.push(v);
            }
            walk(value, depth + 1);
        }
    };
    walk(query, 0);
    walk(body, 0);
    return refs;
}
