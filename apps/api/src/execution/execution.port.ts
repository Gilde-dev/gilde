import { z } from 'zod';

export const EXECUTION_PORT = Symbol('EXECUTION_PORT');

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
    testCommand: z.string(),
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
}

export interface ExecutionPort {
    fire(repo: ExecutionRepo, payload: JobPayload): Promise<ExecutionResult>;
}
