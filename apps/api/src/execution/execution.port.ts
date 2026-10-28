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

/** What trimming took out of the optional context, and what the initial caps already cut. Absent fields are unchanged. */
export const PromptTrimmedSchema = z.object({
    /** Ids of lessons dropped, least relevant first removed. */
    lessonsRemoved: z.array(z.string()).optional(),
    /** Characters kept per downstream task, or 'title-only' when the task keys were left out (criteria are kept). */
    downstreamTaskCap: z.union([z.number().int(), z.literal('title-only')]).optional(),
    /** Downstream jobs left out by the initial 20-job cutoff. */
    downstreamOmitted: z.number().int().optional(),
    /** Ids of downstream jobs removed to fit. */
    downstreamRemoved: z.array(z.string()).optional(),
    /** Characters kept of the feature spec. */
    featureSpecCap: z.number().int().optional(),
});
export type PromptTrimmed = z.infer<typeof PromptTrimmedSchema>;

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
        task: z.string().optional(),
        acceptanceCriteria: z.array(z.string()),
        dependsOn: z.array(z.string()),
    })).optional(),
    lessons: z.array(JobLessonSchema).optional(),
    continueOn: z.object({ branch: z.string(), prNumber: z.number().int(), reason: z.string() }).optional(),
    promptTrimmed: PromptTrimmedSchema.optional(),
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

/** What the initial caps cut while the context was built, and which downstream jobs depend on the job; never sent to the agent. */
export interface PromptContext {
    dependents?: ReadonlySet<string>;
    initial?: { downstreamTaskCap?: number; downstreamOmitted?: number; featureSpecCap?: number };
}

/** The final prompt: exactly the text a fire sends, measured against the limit. */
export interface PreparedPrompt {
    prepared: true;
    /** The payload as rendered, with any trimming and `promptTrimmed` applied. */
    payload: JobPayload;
    text: string;
    length: number;
    limit: number;
    /** False when the text is still over the limit after every reduction; such a prompt must not be fired. */
    fits: boolean;
    instructionsVersion: string | null;
    /** Characters of the agent instructions in the text, 0 when none. */
    instructionsLength: number;
    /** task + criteria characters of this job. */
    ownLength: number;
    trimmed: PromptTrimmed | null;
}

export interface ExecutionPort {
    /** Trims and renders the final text for this payload. Pure: no side effects, and an oversized result is returned, not thrown. */
    prepare(payload: JobPayload, context?: PromptContext): PreparedPrompt;
    /** Fires a payload, or a prompt prepared earlier (which is then sent as is). Throws prompt_too_large when it does not fit. */
    fire(repo: ExecutionRepo, input: JobPayload | PreparedPrompt, context?: PromptContext): Promise<ExecutionResult>;
}
