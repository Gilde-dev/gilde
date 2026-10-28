import { z } from 'zod';

export const ReconcileResultSchema = z.object({
    checked: z.number().int(),
    corrected: z.number().int(),
});
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;

/** The job fields a sync can change. */
export const JobSyncStateSchema = z.object({
    status: z.string(),
    prNumber: z.number().int().nullable(),
    headSha: z.string().nullable(),
    needsApproval: z.boolean(),
});

/** `before` and `after` are the job's state when the check started and when it ended; `changes` is empty when they are equal. */
export const JobSyncResultSchema = z.object({
    jobId: z.string().uuid(),
    pr: z.object({
        number: z.number().int(),
        state: z.enum(['open', 'closed']),
        merged: z.boolean(),
        headSha: z.string(),
    }).nullable(),
    ciConclusion: z.string().nullable(),
    before: JobSyncStateSchema,
    after: JobSyncStateSchema,
    changes: z.array(z.string()),
});
export type JobSyncResultDto = z.infer<typeof JobSyncResultSchema>;
