import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY, type CopilotUser } from './copilot.context.js';
import { SCOUT_AGENT_ID } from './verkenner.config.js';

/** Request-context key with the server-issued binding of a scout run (see ScoutBinding). */
export const SCOUT_BINDING_KEY = 'verkennerBinding';

/** What a scout run is allowed to act on: one project, as the bot user. */
export interface ScoutBinding {
    readonly userId: string;
    readonly projectId: string;
    readonly threadId: string;
}

/** Memory thread of the scout for one project. The resource is always the bot user's id. */
export const scoutThreadId = (projectId: string): string => `${SCOUT_AGENT_ID}:${projectId}`;

/** The project of a scout thread id, or null when it is not one. */
export function scoutProjectOfThread(threadId: string): string | null {
    const prefix = `${SCOUT_AGENT_ID}:`;
    return threadId.startsWith(prefix) && threadId.length > prefix.length ? threadId.slice(prefix.length) : null;
}

/**
 * Bindings issued by the server. A binding is trusted only when this module created it: the set is module-private and
 * holds object identities, so a value that arrives through HTTP (a request body, `requestContext` in JSON) can never be
 * in it, whatever fields it carries. Tools never take the project or user from their input.
 */
const issued = new WeakSet<object>();

export function issueScoutBinding(userId: string, projectId: string): ScoutBinding {
    const binding: ScoutBinding = Object.freeze({ userId, projectId, threadId: scoutThreadId(projectId) });
    issued.add(binding);
    return binding;
}

/** True when this exact object was issued by issueScoutBinding (a look-alike, even a deep copy, is not). */
export const isIssuedScoutBinding = (value: unknown): value is ScoutBinding => typeof value === 'object' && value !== null && issued.has(value);

/** The server-issued binding in the request context, or null (not a scout run, or an unissued look-alike). */
export function scoutBinding(requestContext: Pick<RequestContext, 'get'> | undefined): ScoutBinding | null {
    const value = requestContext?.get(SCOUT_BINDING_KEY) as object | undefined;
    return value && issued.has(value) ? (value as ScoutBinding) : null;
}

/** Like scoutBinding, but throws: a scout tool without a trusted binding does nothing. */
export function requireScoutBinding(requestContext: Pick<RequestContext, 'get'> | undefined): ScoutBinding {
    const binding = scoutBinding(requestContext);
    if (!binding) throw new Error('The scout tools only run in a server-bound Verkenner run');
    return binding;
}

/**
 * The options every scout run gets, whether it is started by an immediate notification or later by the scheduled
 * dispatcher: the memory thread and a request context holding the binding. Built from the thread id, never from input.
 */
export function scoutStreamOptions(user: CopilotUser, projectId: string) {
    const binding = issueScoutBinding(user.id, projectId);
    const requestContext = new RequestContext();
    requestContext.set(SCOUT_BINDING_KEY, binding);
    requestContext.set(COPILOT_USER_KEY, user);
    return { memory: { resource: user.id, thread: binding.threadId }, requestContext };
}
