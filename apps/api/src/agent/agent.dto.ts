import { z } from 'zod';

import { AGENT_IDS } from './agent-ids.js';

export const AGENT_STATUSES = ['on', 'off', 'misconfigured', 'disabled_by_env'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Full replacement of one agent's runtime settings; the per-agent rules are checked by the service (field errors). */
export const ReplaceAgentSettingsSchema = z.object({
    enabled: z.boolean(),
    botUserId: z.string().uuid().nullable(),
    model: z.string().trim().max(200).nullable(),
    settings: z.record(z.string(), z.unknown()),
});

export const AgentIdParamSchema = z.enum(AGENT_IDS);

export type ReplaceAgentSettingsDto = z.infer<typeof ReplaceAgentSettingsSchema>;

export const AgentBotUserSchema = z.object({ id: z.string().uuid(), name: z.string(), email: z.string() });
export type AgentBotUserDto = z.infer<typeof AgentBotUserSchema>;

export const AgentSettingFieldSchema = z.object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(['int', 'number']),
    min: z.number(),
    max: z.number(),
    default: z.number(),
});
export type AgentSettingFieldDto = z.infer<typeof AgentSettingFieldSchema>;

export const AgentSchema = z.object({
    id: z.enum(AGENT_IDS),
    label: z.string(),
    status: z.enum(AGENT_STATUSES),
    /** Why the agent is misconfigured or disabled by the environment; null otherwise. */
    reason: z.string().nullable(),
    enabled: z.boolean(),
    /** The model stored for this agent; null follows the co-pilot's model (bot agents) or does not apply. */
    model: z.string().nullable(),
    /** The model a run uses now, or null when the agent has none. */
    effectiveModel: z.string().nullable(),
    /** Whether this agent has a model / a bot user to choose. */
    hasModel: z.boolean(),
    hasBotUser: z.boolean(),
    botUserId: z.string().uuid().nullable(),
    botUser: AgentBotUserSchema.nullable(),
    settings: z.record(z.string(), z.number()),
    fields: z.array(AgentSettingFieldSchema),
    updatedAt: z.string(),
});
export type AgentDto = z.infer<typeof AgentSchema>;

export const AgentAuditEntrySchema = z.object({
    id: z.string().uuid(),
    agent: z.enum(AGENT_IDS),
    field: z.string(),
    oldValue: z.string().nullable(),
    newValue: z.string().nullable(),
    /** Name and email are null when the account no longer exists. */
    changedBy: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    createdAt: z.string(),
});
export type AgentAuditEntryDto = z.infer<typeof AgentAuditEntrySchema>;

export const AgentToolSchema = z.object({
    name: z.string(),
    description: z.string(),
    access: z.enum(['read', 'write']),
    /** Whether a human has to confirm each call (the co-pilot's writes); the unattended agents' bounded writes need none. */
    needsApproval: z.boolean(),
});
export type AgentToolDto = z.infer<typeof AgentToolSchema>;

export const AgentProjectToolServerSchema = z.object({
    serverId: z.string(),
    serverName: z.string(),
    tools: z.array(z.object({ name: z.string(), mode: z.enum(['read', 'write']), needsApproval: z.boolean() })),
});

/** The tools of the project MCP servers an agent gets when it works in a project. */
export const AgentProjectToolsSchema = z.object({
    projectId: z.string(),
    projectName: z.string(),
    servers: z.array(AgentProjectToolServerSchema),
});
export type AgentProjectToolsDto = z.infer<typeof AgentProjectToolsSchema>;

export const AgentToolsSchema = z.object({
    agent: z.enum(AGENT_IDS),
    /** `allowlist`: the agent's own tools; `routine`: the coding agents use their routine's tools, which Gilde does not control. */
    kind: z.enum(['allowlist', 'routine']),
    tools: z.array(AgentToolSchema),
    /** Plain-text explanation shown with the list, e.g. what the agent can never do. */
    note: z.string().nullable(),
    /** Per project: the attached project MCP tools. Empty for agents that get none. */
    projectTools: z.array(AgentProjectToolsSchema),
});
export type AgentToolsDto = z.infer<typeof AgentToolsSchema>;

export const SlackBotSchema = z.object({
    id: z.literal('slack'),
    label: z.string(),
    status: z.enum(['on', 'off']),
    reason: z.string(),
    /** Bot users that have an API key which is not revoked or expired: the account the channels app acts as. */
    botUsers: z.array(AgentBotUserSchema.extend({ lastUsedAt: z.string().nullable() })),
    notificationKinds: z.array(z.string()),
});
export type SlackBotDto = z.infer<typeof SlackBotSchema>;
