export const AGENT_IDS = ['gilde', 'verkenner', 'verfijner', 'werkmeester', 'mcp', 'coding'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Agents that act as a bot user chosen from the users marked as bots. */
export const BOT_AGENT_IDS = ['verkenner', 'verfijner', 'werkmeester'] as const;
export type BotAgentId = (typeof BOT_AGENT_IDS)[number];

/** Agents that run an LLM and therefore have a model. */
export const MODEL_AGENT_IDS = ['gilde', 'verkenner', 'verfijner', 'werkmeester'] as const;

export const isAgentId = (value: string): value is AgentId => (AGENT_IDS as readonly string[]).includes(value);
export const isBotAgent = (id: AgentId): id is BotAgentId => (BOT_AGENT_IDS as readonly string[]).includes(id);
export const hasModel = (id: AgentId): boolean => (MODEL_AGENT_IDS as readonly string[]).includes(id);

export const AGENT_LABELS: Record<AgentId, string> = {
    gilde: 'Co-pilot',
    verkenner: 'Verkenner',
    verfijner: 'Verfijner',
    werkmeester: 'Werkmeester',
    mcp: 'MCP server',
    coding: 'Coding agents',
};
