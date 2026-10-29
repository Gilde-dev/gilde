import { z } from 'zod';

export const CopilotStatusSchema = z.object({
    enabled: z.boolean(),
    model: z.string().nullable(),
    /** The unattended scout (Verkenner), configured separately from the co-pilot. */
    scout: z.object({ enabled: z.boolean(), model: z.string().nullable() }),
    /** The unattended refine agent (Verfijner) that drafts specs from intake items; without it items stay `new`. */
    refine: z.object({ enabled: z.boolean(), model: z.string().nullable() }),
});
export type CopilotStatusDto = z.infer<typeof CopilotStatusSchema>;

export const ScoutActivityQuerySchema = z.object({ projectId: z.string().uuid() });
export type ScoutActivityQuery = z.infer<typeof ScoutActivityQuerySchema>;

export const ScoutActivityResponseSchema = z.object({
    projectId: z.string().uuid(),
    enabled: z.boolean(),
    model: z.string().nullable(),
    /** Id of the configured scout user when it resolves (also while the scout is off), for comparing with a job's creator. Never the bot's email. */
    scoutUserId: z.string().uuid().nullable(),
    /** Suggestions of this project since Monday 00:00 UTC of the current week. */
    suggestionsThisWeek: z.number().int(),
    /** The UTC day (`YYYY-MM-DD`) of that Monday. */
    weekStart: z.string(),
    /** The actual most recent wake of the scout in this project, or null if it never woke. */
    lastWakeAt: z.string().datetime().nullable(),
});
export type ScoutActivityDto = z.infer<typeof ScoutActivityResponseSchema>;

export const CopilotThreadSchema = z.object({
    id: z.string(),
    /** Mastra's thread title when set, else the first user message cut to 60 characters, else "Untitled conversation". */
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type CopilotThreadDto = z.infer<typeof CopilotThreadSchema>;

/** One message of a thread in the shape the chat (AG-UI) takes as history: user, assistant (with tool calls) and tool results. */
export const CopilotThreadMessageSchema = z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'tool']),
    content: z.string(),
    /** Assistant messages: the tools it called; `arguments` is a JSON string. */
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })).optional(),
    /** Tool messages: the id of the call this result belongs to. */
    toolCallId: z.string().optional(),
});
export type CopilotThreadMessageDto = z.infer<typeof CopilotThreadMessageSchema>;

export const CopilotThreadMessagesSchema = z.object({ thread: CopilotThreadSchema, messages: z.array(CopilotThreadMessageSchema) });
export type CopilotThreadMessagesDto = z.infer<typeof CopilotThreadMessagesSchema>;
