export const RUN_STATUSES = [
    'firing',      // routine fire in progress
    'fired',       // routine fired, waiting for a PR
    'fire_failed', // routine could not be fired
    'pr_opened',
    'ci_passed',
    'ci_failed',
    'timed_out',
    'superseded',  // replaced by a newer attempt
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
