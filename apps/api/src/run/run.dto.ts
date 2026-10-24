import { z } from 'zod';

import { RUN_STATUSES } from './run-status.js';

export const CreateRunSchema = z.object({
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    attempt: z.number().int().min(1),
    status: z.enum(RUN_STATUSES).optional(),
    sessionId: z.string().nullable().optional(),
    sessionUrl: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    firedAt: z.string().datetime().nullable().optional(),
    finishedAt: z.string().datetime().nullable().optional(),
});

export const RunResponseSchema = z.object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    attempt: z.number().int(),
    status: z.enum(RUN_STATUSES),
    sessionId: z.string().nullable(),
    sessionUrl: z.string().nullable(),
    error: z.string().nullable(),
    firedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CreateRunDto = z.infer<typeof CreateRunSchema>;
export type RunResponseDto = z.infer<typeof RunResponseSchema>;
