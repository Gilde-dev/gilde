import { TERMINAL, type JobStatus } from '../../job/job-state.js';
import type { LessonStatus } from '../../lesson/lesson-state.js';

/** What the reconciler scans, in order. Each kind is paged by id. */
export const SCAN_KINDS = ['job', 'run', 'lesson', 'feedback'] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

/** What a chunk in the history index is a piece of. */
export const HISTORY_SOURCE_TYPES = ['job', 'run', 'lesson', 'review', 'review_comment'] as const;
export type HistorySourceType = (typeof HISTORY_SOURCE_TYPES)[number];

/** Jobs whose history is indexed: finished ones, plus parked ones for failure learning. Requeued jobs drop out again. */
export const INDEXED_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([...TERMINAL, 'parked']);
/** Human-approved lesson lifecycle; candidates and rejected lessons are never indexed or returned. */
export const INDEXED_LESSON_STATUSES: readonly LessonStatus[] = ['approved', 'applying', 'applied'];
export const isIndexedLessonStatus = (status: LessonStatus) => INDEXED_LESSON_STATUSES.includes(status);

/** Where an indexed piece of text came from, as of the current source record (never taken from the vector). */
export interface HistoryProvenance {
    projectId: string;
    repoId: string | null;
    repoFullName: string | null;
    jobId: string | null;
    jobTitle: string | null;
    runId: string | null;
    attempt: number | null;
    /** The agent-reported outcome (done, partial, blocked) of the run, or the latest run for a job. */
    outcome: string | null;
    /** Job status, or lesson status for a lesson. */
    status: string | null;
    prUrl: string | null;
    /** Link to the review or review comment on GitHub. */
    url: string | null;
    /** Lessons only: the current lesson text. */
    lessonText: string | null;
}

/** The indexable form of a source record. `repoId` is the vector scope: the repo, or '' for a project-wide lesson. */
export interface HistoryDocument {
    type: HistorySourceType;
    sourceId: string;
    projectId: string;
    repoId: string;
    chunks: string[];
    hash: string;
}

/** A source record as the extraction sees it now. `doc` is null when it is not eligible; `type` is null when it never can be. */
export interface HistoryRecord {
    type: HistorySourceType | null;
    sourceId: string;
    doc: HistoryDocument | null;
    provenance: HistoryProvenance;
}

export const historyKey = (type: HistorySourceType, sourceId: string) => `${type}:${sourceId}`;
export const chunkId = (type: HistorySourceType, sourceId: string, index: number) => `${type}:${sourceId}:${index}`;

export interface HistoryOptions {
    enabled: boolean;
    /** Sources read and compared per batch. */
    batchSize: number;
    /** Batches one run does before it yields; the pass resumes on the next tick. */
    maxBatchesPerRun: number;
    /** Chunks per embedding request (requests are sequential). */
    embedBatchSize: number;
    /** A new pass starts when the last one completed longer ago than this. */
    freshnessMs: number;
    embedAttempts: number;
    retryDelayMs: number;
    /** Hard limit for embedding a query plus the vector query. */
    searchTimeoutMs: number;
}

export const HISTORY_OPTIONS = Symbol('HISTORY_OPTIONS');

export function historyOptions(env: NodeJS.ProcessEnv = process.env): HistoryOptions {
    const int = (value: string | undefined, fallback: number, min: number) => {
        const n = value ? Number(value) : NaN;
        return Number.isInteger(n) && n >= min ? n : fallback;
    };
    return {
        enabled: env.MEMORY_HISTORY_INDEX?.trim().toLowerCase() !== 'off',
        batchSize: int(env.MEMORY_HISTORY_BATCH_SIZE, 25, 1),
        maxBatchesPerRun: int(env.MEMORY_HISTORY_MAX_BATCHES, 20, 1),
        embedBatchSize: 64,
        freshnessMs: int(env.MEMORY_HISTORY_FRESHNESS_SECONDS, 300, 1) * 1000,
        embedAttempts: 3,
        retryDelayMs: 500,
        searchTimeoutMs: int(env.MEMORY_HISTORY_SEARCH_TIMEOUT_MS, 10_000, 100),
    };
}
