// repo.dto.ts
import { z } from 'zod';
import { STACKS } from './repo.entity.js';

/** owner/name, stored lowercase because GitHub names are case-insensitive. */
const fullName = z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'Use owner/name, e.g. gilde-dev/gilde')
    .transform((s) => s.toLowerCase());

const envVarName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Use an UPPER_SNAKE_CASE env var name, e.g. ROUTINE_TOKEN_GILDE');

export const CreateRepoSchema = z.object({
    fullName,
    defaultBranch: z.string().trim().min(1).optional(),
    stack: z.enum(STACKS).optional(),
    testCommand: z.string().trim().min(1),
    routineFireUrl: z.string().url().nullable().optional(),
    routineTokenEnv: envVarName.nullable().optional(),
    maxConcurrentJobs: z.number().int().min(1).max(10).optional(),
});

/** fullName is the identity used by webhooks, so it can't change; register a new repo instead. */
export const UpdateRepoSchema = CreateRepoSchema.omit({ fullName: true }).partial();

export const RepoResponseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    fullName: z.string(),
    defaultBranch: z.string(),
    stack: z.enum(STACKS),
    testCommand: z.string(),
    routineFireUrl: z.string().nullable(),
    routineTokenEnv: z.string().nullable(),
    maxConcurrentJobs: z.number().int(),
    paused: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CreateRepoDto = z.infer<typeof CreateRepoSchema>;
export type UpdateRepoDto = z.infer<typeof UpdateRepoSchema>;
export type RepoResponseDto = z.infer<typeof RepoResponseSchema>;