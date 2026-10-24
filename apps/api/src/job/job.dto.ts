import { z } from 'zod';

import { FeedbackResponseSchema } from '../feedback/feedback.dto.js';
import { RunResponseSchema } from '../run/run.dto.js';
import { JOB_STATUSES } from './job-state.js';

export const CreateJobSchema = z.object({
    title: z.string().trim().min(3).max(200),
    task: z.string().trim().min(10),
    acceptanceCriteria: z.array(z.string().trim().min(3)).max(20).optional(),
    dependsOn: z.array(z.string().uuid()).max(20).optional(),
});

export const SetDependenciesSchema = z.object({
    dependsOn: z.array(z.string().uuid()).max(20),
});

/** Query string for GET /v1/jobs — values arrive as strings, hence z.coerce. */
export const ListJobsQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    repoId: z.string().uuid().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const BlockingJobSchema = z.object({
    id: z.string().uuid(),
    title: z.string(),
    status: z.enum(JOB_STATUSES),
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
    needsApproval: z.boolean(),
    approvalReason: z.string().nullable(),
    dependsOn: z.array(z.string().uuid()),
    blockedBy: z.array(BlockingJobSchema),
    failedDependency: z.boolean().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const JobDetailResponseSchema = JobResponseSchema.extend({
    runs: z.array(RunResponseSchema),
    feedback: z.array(FeedbackResponseSchema),
});

export type SetDependenciesDto = z.infer<typeof SetDependenciesSchema>;
export type BlockingJobDto = z.infer<typeof BlockingJobSchema>;
export type CreateJobDto = z.infer<typeof CreateJobSchema>;
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;
export type JobResponseDto = z.infer<typeof JobResponseSchema>;
export type JobDetailResponseDto = z.infer<typeof JobDetailResponseSchema>;
