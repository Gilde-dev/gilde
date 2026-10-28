// repo.dto.ts
import { z } from 'zod';
import { STACKS } from './repo.entity.js';
import { ManifestSkillsSchema } from './manifest.schema.js';

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
    routineFireUrl: z.string().url().nullable().optional(),
    routineTokenEnv: envVarName.nullable().optional(),
    maxConcurrentJobs: z.number().int().min(1).max(10).optional(),
});

/** Full replacement of a repo's settings (PUT). fullName is the identity used by webhooks, so it can't change; register a new repo instead. */
export const ReplaceRepoSchema = z.object({
    defaultBranch: z.string().trim().min(1),
    routineFireUrl: z.string().url().nullable(),
    routineTokenEnv: envVarName.nullable(),
    maxConcurrentJobs: z.number().int().min(1).max(10),
});

export const RepoResponseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    fullName: z.string(),
    defaultBranch: z.string(),
    routineFireUrl: z.string().nullable(),
    routineTokenEnv: z.string().nullable(),
    maxConcurrentJobs: z.number().int(),
    stacks: z.array(z.enum(STACKS)),
    testCommands: z.array(z.string()),
    skills: ManifestSkillsSchema.nullable(),
    manifestSha: z.string().nullable(),
    manifestSyncedAt: z.string().datetime().nullable(),
    manifestError: z.string().nullable(),
    paused: z.boolean(),
    pausedReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

/** State of the local code clone, for diagnosis. */
export const WorkspaceStatusSchema = z.object({
    cloned: z.boolean(),
    headSha: z.string().nullable(),
    fetchedAt: z.string().nullable(),
    error: z.string().nullable(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export type CreateRepoDto = z.infer<typeof CreateRepoSchema>;
export type ReplaceRepoDto = z.infer<typeof ReplaceRepoSchema>;
export type RepoResponseDto = z.infer<typeof RepoResponseSchema>;