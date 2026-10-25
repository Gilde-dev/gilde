import { z } from 'zod';

export const EXECUTION_PORT = Symbol('EXECUTION_PORT');

/** An approved lesson offered to the agent. Advisory only: it never overrides the task, criteria, repo instructions or safety rules. */
export const JobLessonSchema = z.object({
    id: z.string(),
    text: z.string(),
    scope: z.enum(['project', 'repo']),
    status: z.enum(['approved', 'applying', 'applied']),
    relevance: z.number(),
});
export type JobLesson = z.infer<typeof JobLessonSchema>;

export const JobPayloadSchema = z.object({
    gilde: z.literal(1),
    jobId: z.string(),
    runId: z.string(),
    attempt: z.number().int(),
    repo: z.string(),
    baseBranch: z.string(),
    title: z.string(),
    task: z.string(),
    acceptanceCriteria: z.array(z.string()),
    testCommands: z.array(z.string()),
    stacks: z.array(z.string()),
    feature: z.object({ title: z.string(), spec: z.string(), acceptanceCriteria: z.array(z.string()) }).optional(),
    downstream: z.array(z.object({
        jobId: z.string(),
        title: z.string(),
        task: z.string(),
        acceptanceCriteria: z.array(z.string()),
        dependsOn: z.array(z.string()),
    })).optional(),
    lessons: z.array(JobLessonSchema).optional(),
    continueOn: z.object({ branch: z.string(), prNumber: z.number().int(), reason: z.string() }).optional(),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export interface ExecutionRepo {
    fullName: string;
    routineFireUrl: string | null;
    routineTokenEnv: string | null;
}

export interface ExecutionResult {
    sessionId: string;
    sessionUrl: string;
    /** Version of the agent instructions sent with the job; null when none were configured. */
    instructionsVersion?: string | null;
}

export interface ExecutionPort {
    fire(repo: ExecutionRepo, payload: JobPayload): Promise<ExecutionResult>;
    /** The exact text a fire would send for this payload. No side effects. */
    preview(payload: JobPayload): { text: string; instructionsVersion: string | null };
}
