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
