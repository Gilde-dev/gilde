import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY, type CopilotUser } from './copilot.context.js';
import { REFINE_AGENT_ID } from './verfijner.config.js';

/** Request-context key with the server-issued binding of a refine run (see RefineBinding). */
export const REFINE_BINDING_KEY = 'verfijnerBinding';

/**
 * What a refine run may act on: exactly one intake item, as the bot user. The project, repo and item come from the
 * database row the worker picked; `specId` is the spec linked to the item when the run started (null for a first draft).
 */
export interface RefineBinding {
    readonly userId: string;
    readonly projectId: string;
    readonly repoId: string;
    readonly itemId: string;
    readonly specId: string | null;
    readonly threadId: string;
}

/** Memory thread of one refine attempt. The resource is always the bot user's id. */
export const refineThreadId = (itemId: string, attempt: number): string => `${REFINE_AGENT_ID}:${itemId}:${attempt}`;

/**
 * Bindings issued by the server. A binding is trusted only when this module created it: the set is module-private and
 * holds object identities, so a value that arrives through HTTP (a request body, `requestContext` in JSON) or through
 * tool input can never be in it, whatever fields it carries.
 */
const issued = new WeakSet<object>();

/** What a run did, kept per binding so the worker can tell a saved draft from an agent that just talked. */
export interface RefineOutcome { saves: number }
const outcomes = new WeakMap<object, RefineOutcome>();

export function issueRefineBinding(userId: string, item: { id: string; projectId: string; repoId: string; specId: string | null }, attempt: number): RefineBinding {
    const binding: RefineBinding = Object.freeze({
        userId, projectId: item.projectId, repoId: item.repoId, itemId: item.id, specId: item.specId, threadId: refineThreadId(item.id, attempt),
    });
    issued.add(binding);
    outcomes.set(binding, { saves: 0 });
    return binding;
}

export const isIssuedRefineBinding = (value: unknown): value is RefineBinding => typeof value === 'object' && value !== null && issued.has(value);

/** The server-issued binding in the request context, or null (not a refine run, or an unissued look-alike). */
export function refineBinding(requestContext: Pick<RequestContext, 'get'> | undefined): RefineBinding | null {
    const value = requestContext?.get(REFINE_BINDING_KEY) as object | undefined;
    return value && issued.has(value) ? (value as RefineBinding) : null;
}

/** Like refineBinding, but throws: a refine tool without a trusted binding does nothing. */
export function requireRefineBinding(requestContext: Pick<RequestContext, 'get'> | undefined): RefineBinding {
    const binding = refineBinding(requestContext);
    if (!binding) throw new Error('The Verfijner tools only run in a server-bound Verfijner run');
    return binding;
}

export const refineOutcome = (binding: RefineBinding): RefineOutcome => outcomes.get(binding) ?? { saves: 0 };

/** The options of one refine run: its own memory thread and a request context holding the binding. */
export function refineStreamOptions(user: CopilotUser, binding: RefineBinding) {
    const requestContext = new RequestContext();
    requestContext.set(REFINE_BINDING_KEY, binding);
    requestContext.set(COPILOT_USER_KEY, user);
    return { memory: { resource: user.id, thread: binding.threadId }, requestContext };
}
