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
