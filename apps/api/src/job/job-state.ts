export const JOB_STATUSES = [
    'queued',          // waiting for a free slot
    'dispatched',      // routine fired, waiting for a PR
    'pr_open',         // PR exists, CI running
    'awaiting_review', // CI green, your turn
    'merged',
    'rejected',        // PR closed without merging
    'parked',          // gave up after max attempts; needs you
    'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobEvent =
    | 'fire'         // dispatcher fired a routine
    | 'pr_activity'  // PR opened, or agent pushed new commits
    | 'ci_passed'
    | 'retry'        // something failed, attempts left → back to the queue
    | 'park'         // something failed, no attempts left
    | 'merged'
    | 'closed'       // PR closed without merge
    | 'cancel'
    | 'manual_retry'; // you requeue a parked job

const TRANSITIONS: Record<JobStatus, Partial<Record<JobEvent, JobStatus>>> = {
    queued: { fire: 'dispatched', cancel: 'cancelled' },
    dispatched: { pr_activity: 'pr_open', retry: 'queued', park: 'parked', cancel: 'cancelled' },
    pr_open: { pr_activity: 'pr_open', ci_passed: 'awaiting_review', retry: 'queued', park: 'parked', merged: 'merged', closed: 'rejected' },
    awaiting_review: { pr_activity: 'pr_open', retry: 'queued', park: 'parked', merged: 'merged', closed: 'rejected' },
    parked: { manual_retry: 'queued', cancel: 'cancelled', merged: 'merged', closed: 'rejected' },
    merged: {},
    rejected: {},
    cancelled: {},
};

export const TERMINAL: ReadonlySet<JobStatus> = new Set(['merged', 'rejected', 'cancelled']);
/** Statuses that occupy one of the repo's concurrency slots. */
export const ACTIVE: readonly JobStatus[] = ['dispatched', 'pr_open', 'awaiting_review'];

/** The next status, or null if the event isn't allowed from this status. */
export function nextStatus(current: JobStatus, event: JobEvent): JobStatus | null {
    return TRANSITIONS[current][event] ?? null;
}

/** After a failure: try again, or give up. */
export function retryOrPark(attemptsUsed: number, maxAttempts: number): 'retry' | 'park' {
    return attemptsUsed >= maxAttempts ? 'park' : 'retry';
}