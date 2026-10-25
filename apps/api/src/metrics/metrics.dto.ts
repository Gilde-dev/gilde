import { z } from 'zod';

import { JOB_STATUSES } from '../job/job-state.js';

/** Query string for GET /v1/metrics — values arrive as strings, hence z.coerce. */
export const MetricsQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    repoId: z.string().uuid().optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
});

const rate = z.number().nullable();
const minutes = z.number().nullable();

export const MetricsResponseSchema = z.object({
    days: z.number().int(),
    jobs: z.object({
        total: z.number().int(),
        countByStatus: z.object(Object.fromEntries(JOB_STATUSES.map((s) => [s, z.number().int()])) as Record<(typeof JOB_STATUSES)[number], z.ZodNumber>),
    }),
    mergeRate: rate,
    firstPassRate: rate,
    avgAttempts: z.number().nullable(),
    timeToMerge: z.object({ median: minutes, p90: minutes }),
    runs: z.object({
        total: z.number().int(),
        byOutcome: z.object({
            done: z.number().int(),
            partial: z.number().int(),
            blocked: z.number().int(),
            none: z.number().int(),
        }),
        byCiConclusion: z.record(z.string(), z.number().int()),
        gateFailures: z.number().int(),
    }),
    byInstructionsVersion: z.array(z.object({
        version: z.string(),
        runs: z.number().int(),
        mergedJobs: z.number().int(),
        firstPassRate: rate,
        avgAttempts: z.number().nullable(),
    })),
    daily: z.array(z.object({
        date: z.string(),
        created: z.number().int(),
        merged: z.number().int(),
        parked: z.number().int(),
    })),
});

export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;
export type MetricsResponseDto = z.infer<typeof MetricsResponseSchema>;
