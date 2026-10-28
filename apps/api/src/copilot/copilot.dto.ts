import { z } from 'zod';

export const CopilotStatusSchema = z.object({
    enabled: z.boolean(),
    model: z.string().nullable(),
    /** The unattended scout (Verkenner), configured separately from the co-pilot. */
    scout: z.object({ enabled: z.boolean(), model: z.string().nullable() }),
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
