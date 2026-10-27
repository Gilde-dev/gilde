/**
 * The six factory events the scout is told about. They carry ids and small enums only; the source text (summaries,
 * retros, reviews, tasks) stays in the domain records, where the scout's read tools find it by id.
 */
export type ScoutEvent =
    | { type: 'run_outcome'; outcome: 'blocked' | 'partial'; jobId: string; runId: string; repoId: string }
    | { type: 'job_parked'; jobId: string; repoId: string; attempts: number; cause: string; headSha: string | null }
    | { type: 'changes_requested'; jobId: string; repoId: string; feedbackId: string; prNumber: number }
    | { type: 'lesson_created'; lessonId: string; jobId: string | null }
    | { type: 'feature_done'; featureId: string; doneAt: string }
    | { type: 'job_merged'; jobId: string; repoId: string };

export type ScoutEventType = ScoutEvent['type'];
