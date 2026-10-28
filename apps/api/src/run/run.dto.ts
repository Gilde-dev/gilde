import { z } from 'zod';

import { AgentTotalsSchema } from '../usage/agent-totals.dto.js';
import { gildeResultSchema } from '../webhook/pr-body.js';
import { RUN_STATUSES } from './run-status.js';

export const CreateRunSchema = z.object({
    /** A run id reserved earlier, so the prompt could be sized with the id it will carry. */
    id: z.string().uuid().optional(),
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    attempt: z.number().int().min(1),
    executorId: z.string().uuid().nullable().optional(),
});

export const RunResponseSchema = z.object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    attempt: z.number().int(),
    /** The executor that ran the attempt; null for runs from before personal executors. */
    executorId: z.string().uuid().nullable(),
    status: z.enum(RUN_STATUSES),
    sessionId: z.string().nullable(),
    sessionUrl: z.string().nullable(),
    instructionsVersion: z.string().nullable(),
    error: z.string().nullable(),
    ciConclusion: z.string().nullable(),
    result: gildeResultSchema.nullable(),
    retro: z.string().nullable(),
    firedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

/** A run in a job detail: the run plus its lifetime Claude Code usage (zeros and null cost when no telemetry arrived). */
export const RunExecutorSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    ownerId: z.string().uuid(),
    ownerName: z.string(),
});

export const RunDetailResponseSchema = RunResponseSchema.extend({
    agentUsage: AgentTotalsSchema,
    /** Name and owner of the executor, never its token; null when the run has none or the executor was deleted. */
    executor: RunExecutorSchema.nullable(),
});

export type CreateRunDto = z.infer<typeof CreateRunSchema>;
export type RunResponseDto = z.infer<typeof RunResponseSchema>;
export type RunDetailResponseDto = z.infer<typeof RunDetailResponseSchema>;
