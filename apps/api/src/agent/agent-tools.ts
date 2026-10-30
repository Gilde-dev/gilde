import { createCopilotTools, type CopilotServices } from '../copilot/copilot.tools.js';
import { createRefineTools } from '../copilot/verfijner.tools.js';
import { createScoutTools } from '../copilot/verkenner.tools.js';
import { createPlanTools } from '../copilot/werkmeester.tools.js';
import { createMcpTools, MCP_BOUNDARY } from '../mcp/mcp.tools.js';

import type { AgentId } from './agent-ids.js';
import type { AgentToolDto } from './agent.dto.js';

/** Services that are never called: the factories only close over them, and describing a tool does not run it. */
const NEVER: unknown = new Proxy({}, { get: () => NEVER });

/**
 * The tools that change something, per agent whose tools are not marked by `requireApproval` or annotations. Each name must
 * be one of the agent's tools (agent-tools.spec.ts); everything else the agent has is read-only.
 */
export const UNATTENDED_WRITE_TOOLS = {
    verkenner: ['suggestJob'],
    verfijner: ['saveRefinedSpec'],
    werkmeester: ['proposePlan'],
} as const satisfies Partial<Record<AgentId, readonly string[]>>;

/**
 * The reviewer's whole allowlist: read-only tools over the review context of one pull request (bound to its head and base
 * SHAs). It gets no edit, command, pull-request, policy, spec or merge tool, and no attached project MCP tools; the review
 * execution must build its tools from exactly these names (agent-tools.spec.ts).
 */
export const REVIEWER_TOOLS: readonly AgentToolDto[] = [
    { name: 'listChangedFiles', description: 'List the files changed by the pull request with their change type and size.', access: 'read', needsApproval: false },
    { name: 'readFileAtHead', description: 'Read a file as it is at the reviewed head commit; reports whether the content is complete and what it costs in tokens.', access: 'read', needsApproval: false },
    { name: 'readFileAtBase', description: 'Read a file as it is at the trusted base commit (conventions and unchanged code); reports completeness and token cost.', access: 'read', needsApproval: false },
    { name: 'searchCodeAtHead', description: 'Search the code at the reviewed head commit; reports completeness and token cost.', access: 'read', needsApproval: false },
];

interface ToolLike { description?: string; requireApproval?: boolean }

const byName = (tools: Record<string, ToolLike>, write: (name: string, tool: ToolLike) => { write: boolean; approval: boolean }): AgentToolDto[] =>
    Object.entries(tools)
        .map(([name, tool]) => {
            const { write: isWrite, approval } = write(name, tool);
            return { name, description: tool.description ?? '', access: isWrite ? ('write' as const) : ('read' as const), needsApproval: approval };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

const unattended = (agent: keyof typeof UNATTENDED_WRITE_TOOLS, tools: Record<string, ToolLike>) =>
    byName(tools, (name) => ({ write: (UNATTENDED_WRITE_TOOLS[agent] as readonly string[]).includes(name), approval: false }));

/**
 * The tool allowlist of an agent, taken from the same factories the agents are built with (`create*Tools`, `createMcpTools`),
 * so a tool added to or removed from an agent shows up here without anyone editing a list. Null for agents without Gilde-side tools.
 */
export function toolsOf(agent: AgentId): AgentToolDto[] | null {
    switch (agent) {
        case 'gilde':
            // The co-pilot asks the user to confirm every tool that creates or saves something.
            return byName(createCopilotTools(NEVER as CopilotServices) as Record<string, ToolLike>, (_n, t) => ({ write: t.requireApproval === true, approval: t.requireApproval === true }));
        case 'verkenner':
            return unattended('verkenner', createScoutTools(NEVER as never, NEVER as never, NEVER as never) as Record<string, ToolLike>);
        case 'verfijner':
            return unattended('verfijner', createRefineTools(NEVER as never, NEVER as never) as Record<string, ToolLike>);
        case 'werkmeester':
            return unattended('werkmeester', createPlanTools(NEVER as never, NEVER as never) as Record<string, ToolLike>);
        case 'reviewer':
            return [...REVIEWER_TOOLS];
        case 'mcp':
            return createMcpTools(NEVER as never, NEVER as never, () => undefined)
                .map((t) => ({
                    name: t.name,
                    description: t.description.replace(` ${MCP_BOUNDARY}`, ''),
                    access: t.annotations.readOnlyHint === true ? ('read' as const) : ('write' as const),
                    needsApproval: false,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        case 'coding':
            return null;
    }
}

/** What each agent's tool list means, shown with it. */
export const TOOLS_NOTE: Record<AgentId, string> = {
    gilde: 'The co-pilot acts for the signed-in user. Tools that create or save something ask the user to confirm each call; it can never queue, approve or merge.',
    verkenner: 'Unattended and bound to one project. Its only write is a bounded suggestion that lands in triage; it can never queue, approve or merge.',
    verfijner: 'Unattended and bound to one intake item. Its only write saves a draft spec; it never approves anything.',
    werkmeester: 'Unattended and bound to one approved spec version. Its only write proposes a plan, which creates a draft feature with jobs in triage.',
    reviewer: 'Unattended and read-only, bound to one pull request at one head commit. It reads the review context; it has no tool that edits, runs commands, comments, approves, merges or changes settings, and no project MCP tools.',
    mcp: 'Tools for operators over MCP. Triage and drafts only: nothing is queued, dispatched, cancelled, merged or approved. Writes happen on the operator\'s own authenticated call, without a confirmation step.',
    coding: 'Coding agents run in each user\'s own Claude Code routine and use the tools of that routine. Gilde does not control or list them; what they must and must not do is in the prompt.',
};
