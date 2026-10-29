import { z } from 'zod';

import { AGENT_RUN_AGENTS, AGENT_RUN_OUTCOMES, AGENT_RUN_TRIGGERS } from './agent-run.entity.js';

export const AgentRunsQuerySchema = z.object({
    trigger: z.enum(AGENT_RUN_TRIGGERS).optional(),
    outcome: z.enum(AGENT_RUN_OUTCOMES).optional(),
    projectId: z.string().uuid().optional(),
    /** Coding agents: only the job runs of this executor. */
    executorId: z.string().uuid().optional(),
    /** Runs that started at or after / before this time. */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export type AgentRunsQuery = z.infer<typeof AgentRunsQuerySchema>;

export const DEFAULT_AGENT_RUNS_PAGE_SIZE = 25;

export const AgentIdSchema = z.enum(AGENT_RUN_AGENTS);

export const AgentToolCallSchema = z.object({
    id: z.string().uuid(),
    toolName: z.string(),
    input: z.string().nullable(),
    output: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
});
export type AgentToolCallDto = z.infer<typeof AgentToolCallSchema>;

export const AgentRunSchema = z.object({
    id: z.string().uuid(),
    agentId: z.enum(AGENT_RUN_AGENTS),
    triggerKind: z.enum(AGENT_RUN_TRIGGERS),
    /** Null for another user's co-pilot run: the thread is private. */
    triggerRefType: z.string().nullable(),
    triggerRefId: z.string().nullable(),
    actorUserId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    /** Null while the run is going. */
    outcome: z.enum(AGENT_RUN_OUTCOMES).nullable(),
    /** Null for another user's co-pilot run. */
    reason: z.string().nullable(),
    model: z.string().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    costUsd: z.number().nullable(),
    linkedTable: z.string().nullable(),
    linkedId: z.string().nullable(),
    toolCallCount: z.number().int(),
    /** Coding agents: the executor that ran the job attempt; null otherwise or when it is gone. */
    executor: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    /** True when this is another user's co-pilot run: only metadata is returned, no content. */
    metadataOnly: z.boolean(),
});
export type AgentRunDto = z.infer<typeof AgentRunSchema>;

export const AgentRunDetailSchema = AgentRunSchema.extend({ toolCalls: z.array(AgentToolCallSchema) });
export type AgentRunDetailDto = z.infer<typeof AgentRunDetailSchema>;

export const AgentRunPageSchema = z.object({
    items: z.array(AgentRunSchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
});
export type AgentRunPageDto = z.infer<typeof AgentRunPageSchema>;
