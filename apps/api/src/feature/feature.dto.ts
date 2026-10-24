import { z } from 'zod';

import { JOB_STATUSES } from '../job/job-state.js';
import { BlockingJobSchema, EnqueueWarningSchema, JobResponseSchema } from '../job/job.dto.js';
import { FEATURE_STATUSES } from './feature-state.js';

export const CreateFeatureSchema = z.object({
    title: z.string().trim().min(3).max(200),
    spec: z.string().max(20000).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(3)).max(20).optional(),
});

export const UpdateFeatureSchema = z.object({
    title: z.string().trim().min(3).max(200).optional(),
    spec: z.string().max(20000).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(3)).max(20).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const ListFeaturesQuerySchema = z.object({
    status: z.enum(FEATURE_STATUSES).optional(),
});

export const FeatureProgressSchema = z.object({
    /** Jobs that count towards the feature: everything except cancelled. */
    total: z.number().int(),
    countByStatus: z.record(z.enum(JOB_STATUSES), z.number().int()),
    merged: z.number().int(),
    readyToClose: z.boolean(),
    attempts: z.number().int(),
    /** Minutes from started_at to done_at (or to now while active); null until started. */
    leadTimeMinutes: z.number().int().nullable(),
});

export const FeatureResponseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    title: z.string(),
    spec: z.string(),
    acceptanceCriteria: z.array(z.string()),
    status: z.enum(FEATURE_STATUSES),
    startedAt: z.string().datetime().nullable(),
    doneAt: z.string().datetime().nullable(),
    progress: FeatureProgressSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const FeatureDetailResponseSchema = FeatureResponseSchema.extend({
    jobs: z.array(JobResponseSchema),
});

export const FeatureStartResponseSchema = FeatureResponseSchema.extend({
    warnings: z.array(EnqueueWarningSchema),
});

export const FeatureDoneResponseSchema = FeatureResponseSchema.extend({
    /** Jobs of the feature that are not finished (merged, rejected or cancelled) yet. */
    openJobs: z.array(BlockingJobSchema),
});

export const FeatureCancelResponseSchema = FeatureResponseSchema.extend({
    cancelledJobs: z.array(BlockingJobSchema),
    /** Jobs left alone: in flight (dispatched, PR open, awaiting review) or parked. */
    activeJobs: z.array(BlockingJobSchema),
});

export type CreateFeatureDto = z.infer<typeof CreateFeatureSchema>;
export type UpdateFeatureDto = z.infer<typeof UpdateFeatureSchema>;
export type ListFeaturesQuery = z.infer<typeof ListFeaturesQuerySchema>;
export type FeatureProgressDto = z.infer<typeof FeatureProgressSchema>;
export type FeatureResponseDto = z.infer<typeof FeatureResponseSchema>;
export type FeatureDetailResponseDto = z.infer<typeof FeatureDetailResponseSchema>;
export type FeatureStartResponseDto = z.infer<typeof FeatureStartResponseSchema>;
export type FeatureDoneResponseDto = z.infer<typeof FeatureDoneResponseSchema>;
export type FeatureCancelResponseDto = z.infer<typeof FeatureCancelResponseSchema>;
