import type { JobStatus } from '../job/job-state.js';

/** Token for the lesson hook, so JobService can reach LessonService without an import cycle. */
export const LESSON_JOB_HOOK = Symbol('LESSON_JOB_HOOK');

export interface LessonJobHook {
    onJobEnded(jobId: string, status: JobStatus, reason?: string): Promise<void>;
}
