import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_USER_KEY, type CopilotUser } from './copilot.context.js';
import { PLAN_AGENT_ID } from './werkmeester.config.js';

/** Request-context key with the server-issued binding of a planning run (see PlanBinding). */
export const PLAN_BINDING_KEY = 'werkmeesterBinding';

/**
 * What a planning run may act on: exactly one approved spec version, as the bot user. All of it comes from the database
 * rows the worker picked, never from the model.
 */
export interface PlanBinding {
    readonly userId: string;
    readonly projectId: string;
    readonly specId: string;
    readonly version: number;
    readonly approvalId: string;
    readonly threadId: string;
}

/** Memory thread of one planning attempt. The resource is always the bot user's id. */
export const planThreadId = (specId: string, version: number, attempt: number): string => `${PLAN_AGENT_ID}:${specId}:${version}:${attempt}`;

/**
 * Bindings issued by the server. A binding is trusted only when this module created it: the set is module-private and holds
 * object identities, so a value that arrives through HTTP or through tool input can never be in it, whatever fields it carries.
 */
const issued = new WeakSet<object>();

/** What a run did, kept per binding so the service can tell a created plan from an agent that just talked. */
export interface PlanOutcome {
    featureId: string | null;
    /** Set when the plan can never be created (already planned, no longer approved): the run is skipped, not retried. */
    skipReason: string | null;
    /** The last fixable problems the agent was told about. */
    lastProblems: string[];
}
const outcomes = new WeakMap<object, PlanOutcome>();

export function issuePlanBinding(userId: string, target: { projectId: string; specId: string; version: number; approvalId: string }, attempt: number): PlanBinding {
    const binding: PlanBinding = Object.freeze({
        userId, projectId: target.projectId, specId: target.specId, version: target.version, approvalId: target.approvalId,
        threadId: planThreadId(target.specId, target.version, attempt),
    });
    issued.add(binding);
    outcomes.set(binding, { featureId: null, skipReason: null, lastProblems: [] });
    return binding;
}

export const isIssuedPlanBinding = (value: unknown): value is PlanBinding => typeof value === 'object' && value !== null && issued.has(value);

/** The server-issued binding in the request context, or null (not a planning run, or an unissued look-alike). */
export function planBinding(requestContext: Pick<RequestContext, 'get'> | undefined): PlanBinding | null {
    const value = requestContext?.get(PLAN_BINDING_KEY) as object | undefined;
    return value && issued.has(value) ? (value as PlanBinding) : null;
}

/** Like planBinding, but throws: a Werkmeester tool without a trusted binding does nothing. */
export function requirePlanBinding(requestContext: Pick<RequestContext, 'get'> | undefined): PlanBinding {
    const binding = planBinding(requestContext);
    if (!binding) throw new Error('The Werkmeester tools only run in a server-bound Werkmeester run');
    return binding;
}

export const planOutcome = (binding: PlanBinding): PlanOutcome => outcomes.get(binding) ?? { featureId: null, skipReason: null, lastProblems: [] };

/** The options of one planning run: its own memory thread and a request context holding the binding. */
export function planStreamOptions(user: CopilotUser, binding: PlanBinding) {
    const requestContext = new RequestContext();
    requestContext.set(PLAN_BINDING_KEY, binding);
    requestContext.set(COPILOT_USER_KEY, user);
    return { memory: { resource: user.id, thread: binding.threadId }, requestContext };
}
