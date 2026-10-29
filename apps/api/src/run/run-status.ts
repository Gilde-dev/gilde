export const RUN_STATUSES = [
    'firing',
    'fired',
    'fire_failed',
    'pr_opened',
    'ci_passed',
    'ci_failed',
    'timed_out',
    'superseded',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];


/** What a run is for: a normal attempt, or a round that only merges the base branch into the PR (uses no attempt). */
export const RUN_KINDS = ['attempt', 'conflict_fix'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
