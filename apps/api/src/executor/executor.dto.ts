import { z } from 'zod';

import { EXECUTOR_KINDS } from './executor.entity.js';

export const MAX_EXECUTOR_REPOS = 200;
export const MAX_EXECUTOR_CONCURRENT = 10;
export const MAX_EXECUTOR_DAILY_RUN_LIMIT = 10_000;

const FIRE_PATH = /^\/v1\/claude_code\/routines\/[A-Za-z0-9_-]+\/fire$/;

/** `https://api.anthropic.com/v1/claude_code/routines/<id>/fire`: https only, no credentials, query or fragment. */
export const FireUrlSchema = z.string().trim().max(500).refine((value) => {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return url.protocol === 'https:' && url.hostname === 'api.anthropic.com' && !url.port && !url.username && !url.password
        && !url.search && !url.hash && FIRE_PATH.test(url.pathname);
}, { message: 'Must look like https://api.anthropic.com/v1/claude_code/routines/<id>/fire' });

/** Opaque bearer token: printable, no whitespace. Never echoed in a validation message. */
export const ExecutorTokenSchema = z.string().trim().min(1).max(1000).regex(/^[\x21-\x7e]+$/, { message: 'Must not contain spaces or control characters' });

const NameSchema = z.string().trim().min(1).max(80);
const RepoIdsSchema = z.array(z.string().uuid()).max(MAX_EXECUTOR_REPOS);
const MaxConcurrentSchema = z.number().int().min(1).max(MAX_EXECUTOR_CONCURRENT);
const DailyRunLimitSchema = z.number().int().min(1).max(MAX_EXECUTOR_DAILY_RUN_LIMIT);

export const CreateExecutorSchema = z.object({
    name: NameSchema,
    fireUrl: FireUrlSchema,
    token: ExecutorTokenSchema,
    repoIds: RepoIdsSchema,
    maxConcurrent: MaxConcurrentSchema.optional(),
    dailyRunLimit: DailyRunLimitSchema.nullable().optional(),
    enabled: z.boolean().optional(),
});
export type CreateExecutorDto = z.infer<typeof CreateExecutorSchema>;

/** Full replacement of the updatable fields; the token is replaced through its own route. */
export const ReplaceExecutorSchema = z.object({
    name: NameSchema,
    fireUrl: FireUrlSchema,
    repoIds: RepoIdsSchema,
    maxConcurrent: MaxConcurrentSchema,
    dailyRunLimit: DailyRunLimitSchema.nullable(),
    enabled: z.boolean(),
});
export type ReplaceExecutorDto = z.infer<typeof ReplaceExecutorSchema>;

export const ReplaceExecutorTokenSchema = z.object({
    token: ExecutorTokenSchema,
});
export type ReplaceExecutorTokenDto = z.infer<typeof ReplaceExecutorTokenSchema>;

/** Never carries the token, its ciphertext, IV or tag. */
export const ExecutorResponseSchema = z.object({
    id: z.string(),
    ownerId: z.string(),
    name: z.string(),
    kind: z.enum(EXECUTOR_KINDS),
    fireUrl: z.string(),
    hasToken: z.boolean(),
    tokenLast4: z.string().nullable(),
    repoIds: z.array(z.string()),
    maxConcurrent: z.number(),
    dailyRunLimit: z.number().nullable(),
    enabled: z.boolean(),
    exhaustedUntil: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type ExecutorResponseDto = z.infer<typeof ExecutorResponseSchema>;
