import { z } from 'zod';

import { gildeResultSchema } from '../webhook/pr-body.js';
import { RUN_STATUSES } from './run-status.js';

export const CreateRunSchema = z.object({
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    attempt: z.number().int().min(1),
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
    ciConclusion: z.string().nullable(),
    result: gildeResultSchema.nullable(),
    retro: z.string().nullable(),
    firedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CreateRunDto = z.infer<typeof CreateRunSchema>;
export type RunResponseDto = z.infer<typeof RunResponseSchema>;
