import { z } from 'zod';

import { RunResponseSchema } from '../run/run.dto.js';
import { JOB_STATUSES } from './job-state.js';

export const CreateJobSchema = z.object({
    title: z.string().trim().min(3).max(200),
    task: z.string().trim().min(10),
    acceptanceCriteria: z.array(z.string().trim().min(3)).max(20).optional(),
});

/** Query string for GET /v1/jobs — values arrive as strings, hence z.coerce. */
export const ListJobsQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    repoId: z.string().uuid().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const JobResponseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    title: z.string(),
    task: z.string(),
    acceptanceCriteria: z.array(z.string()),
    status: z.enum(JOB_STATUSES),
    attempts: z.number().int(),
    queuedAt: z.string().datetime(),
    prNumber: z.number().int().nullable(),
    prUrl: z.string().nullable(),
    branch: z.string().nullable(),
    lastReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

/** GET /v1/jobs/:id — the job plus its runs, ordered by attempt. */
export const JobDetailResponseSchema = JobResponseSchema.extend({
    runs: z.array(RunResponseSchema),
});

export type CreateJobDto = z.infer<typeof CreateJobSchema>;
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;
export type JobResponseDto = z.infer<typeof JobResponseSchema>;
export type JobDetailResponseDto = z.infer<typeof JobDetailResponseSchema>;