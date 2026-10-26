import { z } from 'zod';

import { USAGE_KINDS } from './usage.entity.js';

export const UsageQuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
    userId: z.string().uuid().optional(),
    kind: z.enum(USAGE_KINDS).optional(),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

const tokens = z.object({
    inputTokens: z.number().int(),
    cachedInputTokens: z.number().int(),
    outputTokens: z.number().int(),
    reasoningTokens: z.number().int(),
    totalTokens: z.number().int(),
    /** Sum over the rows with a known price; null when no row has one. */
    costUsd: z.number().nullable(),
    runs: z.number().int(),
});

export const UsageResponseSchema = z.object({
    days: z.number().int(),
    totals: tokens,
    daily: z.array(tokens.extend({ date: z.string() })),
    byModel: z.array(tokens.extend({ model: z.string() })),
    byKind: z.array(tokens.extend({ kind: z.enum(USAGE_KINDS) })),
    byUser: z.array(tokens.extend({ userId: z.string().nullable(), userName: z.string().nullable() })),
});
export type UsageResponseDto = z.infer<typeof UsageResponseSchema>;
export type UsageTotalsDto = z.infer<typeof tokens>;

/** A usage record as the recorders produce it; cost and time are filled in by the service. */
export interface UsageRecord {
    kind: (typeof USAGE_KINDS)[number];
    model: string;
    userId?: string | null;
    threadId?: string | null;
    agent?: string | null;
    steps?: number | null;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
}

export const AgentUsageQuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
    projectId: z.string().uuid().optional(),
});
export type AgentUsageQuery = z.infer<typeof AgentUsageQuerySchema>;
