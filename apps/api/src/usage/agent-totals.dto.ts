import { z } from 'zod';

/**
 * Claude Code usage totals, same keys as the co-pilot's `UsageTotalsDto` plus `cacheCreationTokens`.
 * `inputTokens` = uncached + cache read + cache creation; `cachedInputTokens` is the cache-read subset;
 * `totalTokens` = inputTokens + outputTokens (inclusive, counted once); `reasoningTokens` is always 0 (no source evidence);
 * `runs` counts API-request rows (shown as "Requests"). `costUsd` sums Claude Code's own (notional) estimates.
 */
export const AgentTotalsSchema = z.object({
    inputTokens: z.number().int(),
    cachedInputTokens: z.number().int(),
    cacheCreationTokens: z.number().int(),
    outputTokens: z.number().int(),
    reasoningTokens: z.number().int(),
    totalTokens: z.number().int(),
    /** Sum of the known estimates; null when no row has one, 0 when the estimates are really 0. */
    costUsd: z.number().nullable(),
    runs: z.number().int(),
    /** The stored uncached input, so the four stored categories stay recoverable. */
    uncachedInputTokens: z.number().int(),
    /** Requests without a cost estimate; `costUsd` is partial when this is > 0 and < runs. */
    costUnknownRequests: z.number().int(),
    costPartial: z.boolean(),
});
export type AgentTotalsDto = z.infer<typeof AgentTotalsSchema>;

/** Optional scope of an aggregate. `projectId` filters on the ATTRIBUTED run's project (unattributed rows are then excluded). */
export interface AgentUsageFilter {
    projectId?: string;
    /** Inclusive start / exclusive end of the event time (UTC). */
    from?: Date;
    to?: Date;
}

export interface AgentUsageWindow {
    days: number;
    from: Date;
    to: Date;
}
