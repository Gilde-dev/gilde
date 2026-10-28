import { z } from 'zod';

import { HISTORY_SOURCE_TYPES } from './history.types.js';

export const HISTORY_MAX_TOP_K = 10;
export const HISTORY_DEFAULT_TOP_K = 5;
export const HISTORY_MAX_QUERY_CHARS = 2000;
export const HISTORY_MAX_EXCERPT_CHARS = 1200;

export const HistorySearchSchema = z.object({
    projectId: z.string().uuid(),
    repoId: z.string().uuid().optional(),
    query: z.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS),
    topK: z.number().int().min(1).max(HISTORY_MAX_TOP_K).optional(),
    types: z.array(z.enum(HISTORY_SOURCE_TYPES)).min(1).max(HISTORY_SOURCE_TYPES.length).optional(),
});
export type HistorySearchInput = z.infer<typeof HistorySearchSchema>;

export const HistoryHitSchema = z.object({
    /** Cosine similarity of the best matching chunk, 0 to 1. */
    score: z.number(),
    sourceType: z.enum(HISTORY_SOURCE_TYPES),
    sourceId: z.string(),
    projectId: z.string(),
    repoId: z.string().nullable(),
    repoFullName: z.string().nullable(),
    jobId: z.string().nullable(),
    jobTitle: z.string().nullable(),
    runId: z.string().nullable(),
    attempt: z.number().nullable(),
    /** Agent-reported outcome of the run (or the latest run of the job); null when none was recorded. */
    outcome: z.string().nullable(),
    /** Current job status, or current lesson status. */
    status: z.string().nullable(),
    prUrl: z.string().nullable(),
    /** Link to the review or review comment on GitHub. */
    url: z.string().nullable(),
    excerpt: z.string(),
});
export type HistoryHitDto = z.infer<typeof HistoryHitSchema>;

/** `ok` with no results means nothing matched; `unavailable` means retrieval could not run, so nothing can be concluded. */
export const HistorySearchResultSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), results: z.array(HistoryHitSchema), indexComplete: z.boolean(), suppressed: z.number() }),
    z.object({ status: z.literal('unavailable'), reason: z.string(), results: z.tuple([]) }),
]);
export type HistorySearchResultDto = z.infer<typeof HistorySearchResultSchema>;

export const HistoryLessonHitSchema = z.object({
    lessonId: z.string(),
    projectId: z.string(),
    /** null for a project-wide lesson. */
    targetRepoId: z.string().nullable(),
    status: z.string(),
    score: z.number(),
    /** The current lesson text, bounded. */
    text: z.string(),
});
export type HistoryLessonHitDto = z.infer<typeof HistoryLessonHitSchema>;

export const HistoryLessonResultSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), lessons: z.array(HistoryLessonHitSchema) }),
    z.object({ status: z.literal('unavailable'), reason: z.string(), lessons: z.tuple([]) }),
]);
export type HistoryLessonResultDto = z.infer<typeof HistoryLessonResultSchema>;

const HistoryPassStatsSchema = z.object({
    indexed: z.number(),
    unchanged: z.number(),
    removed: z.number(),
    embeddedChunks: z.number(),
});

export const HistoryRunSummarySchema = z.object({
    /** idle: nothing due; partial: the run budget ended mid-pass (resumes next tick); complete: the pass finished. */
    outcome: z.enum(['disabled', 'idle', 'partial', 'complete', 'failed']),
    batches: z.number(),
    stats: HistoryPassStatsSchema,
    error: z.string().optional(),
});
export type HistoryRunSummary = z.infer<typeof HistoryRunSummarySchema>;

/** Timestamps are ISO strings, as they were on the wire when this returned Date objects. */
export const HistoryStatusSchema = z.object({
    enabled: z.boolean(),
    embeddings: z.boolean(),
    reason: z.string().nullable(),
    indexName: z.string(),
    indexedSources: z.number(),
    passInProgress: z.boolean(),
    progress: z.object({ scanKind: z.string().nullable(), phase: z.string().nullable(), cursor: z.string().nullable() }),
    passStartedAt: z.string().nullable(),
    lastCompletedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
    consecutiveFailures: z.number(),
    stats: HistoryPassStatsSchema.nullable(),
});
export type HistoryStatus = z.infer<typeof HistoryStatusSchema>;
