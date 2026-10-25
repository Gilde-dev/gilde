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

export interface HistoryHitDto {
    /** Cosine similarity of the best matching chunk, 0 to 1. */
    score: number;
    sourceType: (typeof HISTORY_SOURCE_TYPES)[number];
    sourceId: string;
    projectId: string;
    repoId: string | null;
    repoFullName: string | null;
    jobId: string | null;
    jobTitle: string | null;
    runId: string | null;
    attempt: number | null;
    /** Agent-reported outcome of the run (or the latest run of the job); null when none was recorded. */
    outcome: string | null;
    /** Current job status, or current lesson status. */
    status: string | null;
    prUrl: string | null;
    /** Link to the review or review comment on GitHub. */
    url: string | null;
    excerpt: string;
}

/** `ok` with no results means nothing matched; `unavailable` means retrieval could not run, so nothing can be concluded. */
export type HistorySearchResultDto =
    | { status: 'ok'; results: HistoryHitDto[]; indexComplete: boolean; suppressed: number }
    | { status: 'unavailable'; reason: string; results: [] };

export interface HistoryLessonHitDto {
    lessonId: string;
    projectId: string;
    /** null for a project-wide lesson. */
    targetRepoId: string | null;
    status: string;
    score: number;
    /** The current lesson text, bounded. */
    text: string;
}

export type HistoryLessonResultDto =
    | { status: 'ok'; lessons: HistoryLessonHitDto[] }
    | { status: 'unavailable'; reason: string; lessons: [] };
