import { z } from 'zod';

import { PromptTrimmedSchema } from '../execution/execution.port.js';
import { FeedbackResponseSchema } from '../feedback/feedback.dto.js';
import { RunDetailResponseSchema } from '../run/run.dto.js';
import { AgentTotalsSchema } from '../usage/agent-totals.dto.js';
import { JOB_STATUSES } from './job-state.js';

export const CreateJobSchema = z.object({
    title: z.string().trim().min(3).max(200),
    task: z.string().trim().min(10),
    acceptanceCriteria: z.array(z.string().trim().min(3)).max(20).optional(),
    dependsOn: z.array(z.string().uuid()).max(20).optional(),
    status: z.enum(['triage', 'queued']).optional(),
    featureId: z.string().uuid().optional(),
});

/** The text limits of a job, shared by every creator of jobs (HTTP, the co-pilot's validateJob, the scout's suggestJob). */
export const JobContentSchema = CreateJobSchema.pick({ title: true, task: true, acceptanceCriteria: true });

/** Full replacement of a job's updatable fields (PUT); `featureId: null` unlinks the feature. */
export const ReplaceJobSchema = z.object({
    title: z.string().trim().min(3).max(200),
    task: z.string().trim().min(10),
    acceptanceCriteria: z.array(z.string().trim().min(3)).max(20),
    featureId: z.string().uuid().nullable(),
});

export const SendBackSchema = z.object({
    reason: z.string().trim().min(1).max(4000),
});
export type SendBackDto = z.infer<typeof SendBackSchema>;

export const BulkEnqueueSchema = z.object({
    ids: z.array(z.string().uuid()).min(1).max(50),
});

export const SetDependenciesSchema = z.object({
    dependsOn: z.array(z.string().uuid()).max(20),
});

/** Page size when `limit` is omitted; applied by JobService.list. */
export const DEFAULT_JOB_LIST_LIMIT = 50;

/** Query string for GET /v1/jobs — values arrive as strings, hence z.coerce. */
export const ListJobsQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    repoId: z.string().uuid().optional(),
    featureId: z.string().uuid().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    createdBy: z.union([z.literal('me'), z.string().uuid()]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const BlockingJobSchema = z.object({
    id: z.string().uuid(),
    title: z.string(),
    status: z.enum(JOB_STATUSES),
    /** Merged on GitHub, but its latest run reported blocked: it does not satisfy the dependency. */
    mergedBlocked: z.boolean().optional(),
});

export const JobCreatorSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
});

export const JobResponseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    featureId: z.string().uuid().nullable(),
    title: z.string(),
    task: z.string(),
    acceptanceCriteria: z.array(z.string()),
    status: z.enum(JOB_STATUSES),
    attempts: z.number().int(),
    queuedAt: z.string().datetime().nullable(),
    prNumber: z.number().int().nullable(),
    prUrl: z.string().nullable(),
    branch: z.string().nullable(),
    lastReason: z.string().nullable(),
    needsApproval: z.boolean(),
    approvalReason: z.string().nullable(),
    dependsOn: z.array(z.string().uuid()),
    blockedBy: z.array(BlockingJobSchema),
    pendingRevisions: z.number().int(),
    revision: z.number().int(),
    failedDependency: z.boolean().optional(),
    /** Merged without work: status merged and the latest run's result is blocked. */
    mergedBlocked: z.boolean(),
    /** The job made by "Recreate job" to replace this one, if any. */
    replacedById: z.string().uuid().nullable(),
    /** The merged-without-work job this one was recreated from, if any. */
    recreatedFromId: z.string().uuid().nullable(),
    createdBy: JobCreatorSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const JobDetailResponseSchema = JobResponseSchema.extend({
    runs: z.array(RunDetailResponseSchema),
    /** Lifetime Claude Code usage of all runs of the job (estimated, notional cost). */
    agentUsage: AgentTotalsSchema,
    feedback: z.array(FeedbackResponseSchema),
});

export const EnqueueWarningSchema = z.object({
    dependencyId: z.string().uuid(),
    message: z.string(),
});

export const EnqueueResponseSchema = JobResponseSchema.extend({
    warnings: z.array(EnqueueWarningSchema),
});


export const JobPromptResponseSchema = z.object({
    /** Exactly what a fire would send, even when it is over the limit (then a fire refuses it). */
    text: z.string(),
    instructionsVersion: z.string().nullable(),
    length: z.number().int(),
    limit: z.number().int(),
    /** What was cut from the optional context; null when nothing was. */
    trimmed: PromptTrimmedSchema.nullable(),
});
export type JobPromptResponseDto = z.infer<typeof JobPromptResponseSchema>;

export type ReplaceJobDto = z.infer<typeof ReplaceJobSchema>;
export type BulkEnqueueDto = z.infer<typeof BulkEnqueueSchema>;
export type EnqueueWarningDto = z.infer<typeof EnqueueWarningSchema>;
export type EnqueueResponseDto = z.infer<typeof EnqueueResponseSchema>;
export type SetDependenciesDto = z.infer<typeof SetDependenciesSchema>;
export type BlockingJobDto = z.infer<typeof BlockingJobSchema>;
export type CreateJobDto = z.infer<typeof CreateJobSchema>;
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;
export type JobResponseDto = z.infer<typeof JobResponseSchema>;
export type JobDetailResponseDto = z.infer<typeof JobDetailResponseSchema>;
