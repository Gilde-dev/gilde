import { AGENT_IDS, isAgentId, type AgentId } from './agent-ids.js';

/**
 * AGENTS_DISABLED: comma-separated agent ids, or `all`. It forces those agents off whatever the database says. An unknown
 * id throws (fail closed: a typo must not leave the agent running); error messages never contain more than the bad id.
 */
export function agentsDisabled(env: NodeJS.ProcessEnv = process.env): ReadonlySet<AgentId> {
    const raw = env.AGENTS_DISABLED?.trim();
    if (!raw) return new Set();
    const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (parts.includes('all')) return new Set(AGENT_IDS);
    const unknown = parts.filter((p) => !isAgentId(p));
    if (unknown.length > 0) throw new Error(`AGENTS_DISABLED contains unknown agent ids: ${unknown.join(', ')} (use ${AGENT_IDS.join(', ')} or all)`);
    return new Set(parts as AgentId[]);
}
