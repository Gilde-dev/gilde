import { z } from 'zod';

import { LESSON_STATUSES } from './lesson-state.js';
import { LESSON_TARGET_KINDS } from './lesson.entity.js';
import { LESSON_SOURCE_KINDS } from './lesson-source.entity.js';

export const ListLessonsQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    status: z.enum(LESSON_STATUSES).optional(),
});

export const UpdateLessonSchema = z.object({
    text: z.string().trim().min(1).max(10_000),
    targetKind: z.enum(LESSON_TARGET_KINDS).nullable(),
    targetRepoId: z.string().uuid().nullable(),
    note: z.string().max(10_000).nullable(),
}).partial();

export const MergeLessonsSchema = z.object({
    targetId: z.string().uuid(),
    lessonIds: z.array(z.string().uuid()).min(1),
});

export const LessonSourceResponseSchema = z.object({
    id: z.string().uuid(),
    kind: z.enum(LESSON_SOURCE_KINDS),
    jobId: z.string().uuid(),
    runId: z.string().nullable(),
    feedbackId: z.string().nullable(),
    excerpt: z.string(),
    /** PR of the source job, if it has one. */
    prUrl: z.string().nullable(),
    createdAt: z.string().datetime(),
});

export const LessonResponseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    text: z.string(),
    status: z.enum(LESSON_STATUSES),
    targetKind: z.enum(LESSON_TARGET_KINDS).nullable(),
    targetRepoId: z.string().nullable(),
    note: z.string().nullable(),
    appliedJobId: z.string().nullable(),
    /** PR of the job that applies the lesson, if it has one. */
    appliedJobPrUrl: z.string().nullable(),
    appliedAt: z.string().datetime().nullable(),
    sources: z.array(LessonSourceResponseSchema),
    /** Number of distinct jobs among the sources. */
    sourceCount: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type ListLessonsQuery = z.infer<typeof ListLessonsQuerySchema>;
export type UpdateLessonDto = z.infer<typeof UpdateLessonSchema>;
export type MergeLessonsDto = z.infer<typeof MergeLessonsSchema>;
export type LessonSourceResponseDto = z.infer<typeof LessonSourceResponseSchema>;
export type LessonResponseDto = z.infer<typeof LessonResponseSchema>;
export interface CollectResultDto { created: number }
