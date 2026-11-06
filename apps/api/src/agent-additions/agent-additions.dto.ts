import { z } from 'zod';

import { ADDITION_AGENT_IDS } from './agent-additions.render.js';

export const ReplaceAgentInstructionSchema = z.object({ text: z.string() }).strict();
export type ReplaceAgentInstructionDto = z.infer<typeof ReplaceAgentInstructionSchema>;

const UserRef = z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string().nullable() });

export const AgentInstructionSchema = z.object({
    agentId: z.enum(ADDITION_AGENT_IDS),
    /** Empty when the agent has no addition in this project. */
    text: z.string(),
    /** 0 when an addition was never set. */
    version: z.number().int(),
    updatedAt: z.string().nullable(),
    updatedBy: UserRef.nullable(),
});
export type AgentInstructionDto = z.infer<typeof AgentInstructionSchema>;

export const AgentInstructionsSchema = z.object({
    projectId: z.string().uuid(),
    maxChars: z.number().int(),
    agents: z.array(AgentInstructionSchema),
});
export type AgentInstructionsDto = z.infer<typeof AgentInstructionsSchema>;

export const AgentInstructionVersionSchema = z.object({
    version: z.number().int(),
    text: z.string(),
    /** True for the version in use now. */
    current: z.boolean(),
    updatedAt: z.string(),
    updatedBy: UserRef,
});
export type AgentInstructionVersionDto = z.infer<typeof AgentInstructionVersionSchema>;
