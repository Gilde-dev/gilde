import { z } from 'zod';

import { JOB_STATUSES } from '../job/job-state.js';
import { REVISION_STATUSES } from './revision.entity.js';

export const ListRevisionsQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    status: z.enum(REVISION_STATUSES).optional(),
});

export const RevisionResponseSchema = z.object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    revision: z.number().int().nullable(),
    title: z.string().nullable(),
    task: z.string().nullable(),
    acceptanceCriteria: z.array(z.string()).nullable(),
    dependsOn: z.array(z.string().uuid()).nullable(),
    reason: z.string(),
    sourceRunId: z.string().uuid().nullable(),
    status: z.enum(REVISION_STATUSES),
    decidedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    /** The job as it is now, to diff against. */
    job: z.object({
        id: z.string().uuid(),
        title: z.string(),
        task: z.string(),
        acceptanceCriteria: z.array(z.string()),
        dependsOn: z.array(z.string().uuid()),
        status: z.enum(JOB_STATUSES),
    }),
    /** The PR of the run that proposed it. */
    pr: z.object({ number: z.number().int(), url: z.string() }).nullable(),
});

export type ListRevisionsQuery = z.infer<typeof ListRevisionsQuerySchema>;
export type RevisionResponseDto = z.infer<typeof RevisionResponseSchema>;
