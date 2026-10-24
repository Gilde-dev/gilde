export const LESSON_STATUSES = ['candidate', 'approved', 'applying', 'applied', 'rejected'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export type LessonEvent = 'approve' | 'reject' | 'reopen' | 'apply' | 'job_merged' | 'job_failed' | 'mark_applied';

// `applied` is final.
const TRANSITIONS: Record<LessonStatus, Partial<Record<LessonEvent, LessonStatus>>> = {
    candidate: { approve: 'approved', reject: 'rejected' },
    approved: { reopen: 'candidate', reject: 'rejected', apply: 'applying', mark_applied: 'applied' },
    applying: { job_merged: 'applied', job_failed: 'approved' },
    applied: {},
    rejected: { reopen: 'candidate' },
};

/** The next status, or null if the event isn't allowed from this status. */
export function nextLessonStatus(current: LessonStatus, event: LessonEvent): LessonStatus | null {
    return TRANSITIONS[current][event] ?? null;
}
