import type { JobStatus } from '../job/job-state.js';

/** CI conclusions that count as passing; mirrors JobEventsService. */
const CI_OK = new Set(['success', 'neutral', 'skipped']);

export type ResultOutcome = 'done' | 'partial' | 'blocked' | 'none';

/** Existing data of one run and its job; nothing here is derived from anything but stored rows. */
export interface RunFacts {
    attempt: number;
    resultOutcome: 'done' | 'partial' | 'blocked' | null;
    ciConclusion: string | null;
    jobStatus: JobStatus;
    jobMergedBlocked: boolean;
    /** Accepted revision proposals on the job. */
    revisionRounds: number;
    /** The highest attempt number of the job that has a run row. */
    latestAttempt: number;
    /** Attributed agent tokens (all categories, counted once) or null when the run has no attributed usage. */
    tokens: number | null;
    costUsd: number | null;
}

export interface RunOutcome {
    result: ResultOutcome;
    /** CI reported a conclusion that is not passing. */
    ciFailed: boolean;
    revisionRounds: number;
    /** The job ended merged with work done (a merged PR whose result was blocked does not count). */
    merged: boolean;
    rejectedOrParked: boolean;
    cancelled: boolean;
    /** A later attempt replaced this run. */
    superseded: boolean;
    attempt: number;
    tokens: number | null;
    costUsd: number | null;
}

const END_STATES: ReadonlySet<JobStatus> = new Set(['merged', 'rejected', 'parked', 'cancelled']);

/** A run is finished when its job reached an end state or a later attempt superseded it. */
export function isFinished(f: Pick<RunFacts, 'attempt' | 'latestAttempt' | 'jobStatus'>): boolean {
    return END_STATES.has(f.jobStatus) || f.latestAttempt > f.attempt;
}

/** Classifies a finished run; returns null for a run that is still in flight. */
export function classifyRun(f: RunFacts): RunOutcome | null {
    if (!isFinished(f)) return null;
    return {
        result: f.resultOutcome ?? 'none',
        ciFailed: f.ciConclusion !== null && !CI_OK.has(f.ciConclusion),
        revisionRounds: f.revisionRounds,
        merged: f.jobStatus === 'merged' && !f.jobMergedBlocked,
        rejectedOrParked: f.jobStatus === 'rejected' || f.jobStatus === 'parked',
        cancelled: f.jobStatus === 'cancelled',
        superseded: f.latestAttempt > f.attempt,
        attempt: f.attempt,
        tokens: f.tokens,
        costUsd: f.costUsd,
    };
}
