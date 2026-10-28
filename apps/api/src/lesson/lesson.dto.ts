import { z } from 'zod';

import { LESSON_STATUSES } from './lesson-state.js';
import { LESSON_TARGET_KINDS, SETTABLE_LESSON_TARGET_KINDS } from './lesson.entity.js';
import { LESSON_SOURCE_KINDS } from './lesson-source.entity.js';

export const ListLessonsQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    status: z.enum(LESSON_STATUSES).optional(),
});

/** Full replacement of a lesson's editable fields (PUT); null clears targetKind, targetRepoId and note. */
export const ReplaceLessonSchema = z.object({
    text: z.string().trim().min(1).max(10_000),
    targetKind: z.enum(SETTABLE_LESSON_TARGET_KINDS).nullable(),
    targetRepoId: z.string().uuid().nullable(),
    note: z.string().max(10_000).nullable(),
});

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
export type ReplaceLessonDto = z.infer<typeof ReplaceLessonSchema>;
export type MergeLessonsDto = z.infer<typeof MergeLessonsSchema>;
export type LessonSourceResponseDto = z.infer<typeof LessonSourceResponseSchema>;
export type LessonResponseDto = z.infer<typeof LessonResponseSchema>;
export const CollectResultSchema = z.object({ created: z.number().int() });
export type CollectResultDto = z.infer<typeof CollectResultSchema>;

export const LESSON_PATTERN_MIN_SIZE = 2;

/** Query of the patterns endpoint; the default minimum size is applied by the service. */
export const ListLessonPatternsQuerySchema = z.object({
    minSize: z.coerce.number().int().min(LESSON_PATTERN_MIN_SIZE).max(100).optional(),
});

export const LessonPatternMemberSchema = z.object({
    lessonId: z.string().uuid(),
    text: z.string(),
    status: z.enum(LESSON_STATUSES),
    sources: z.array(LessonSourceResponseSchema),
});

/** An applied or applying lesson that says (nearly) the same as the pattern: context, not a member. */
export const LessonPatternCoveredSchema = z.object({
    lessonId: z.string().uuid(),
    text: z.string(),
    status: z.enum(LESSON_STATUSES),
    appliedJobId: z.string().nullable(),
});

export const LessonPatternSchema = z.object({
    /** Hash of the sorted member lesson ids: changes when the members change. */
    id: z.string(),
    representativeText: z.string(),
    size: z.number().int(),
    members: z.array(LessonPatternMemberSchema),
    jobIds: z.array(z.string()),
    runIds: z.array(z.string()),
    repoIds: z.array(z.string()),
    firstSeen: z.string().datetime(),
    lastSeen: z.string().datetime(),
    alreadyCovered: z.array(LessonPatternCoveredSchema),
});

export const LessonPatternsResponseSchema = z.object({
    /** How lessons were compared: cached embeddings, or normalized-text similarity. */
    method: z.enum(['embeddings', 'text']),
    threshold: z.number(),
    patterns: z.array(LessonPatternSchema),
});

export type ListLessonPatternsQuery = z.infer<typeof ListLessonPatternsQuerySchema>;
export type LessonPatternMemberDto = z.infer<typeof LessonPatternMemberSchema>;
export type LessonPatternDto = z.infer<typeof LessonPatternSchema>;
export type LessonPatternsResponseDto = z.infer<typeof LessonPatternsResponseSchema>;
