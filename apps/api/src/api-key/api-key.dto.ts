import { z } from 'zod';

export const MAX_EXPIRES_IN_DAYS = 3650;

export const CreateApiKeySchema = z.object({
    name: z.string().trim().min(1).max(100),
    expiresInDays: z.number().int().min(1).max(MAX_EXPIRES_IN_DAYS).optional(),
});

export type CreateApiKeyDto = z.infer<typeof CreateApiKeySchema>;

/** Listed keys never carry the secret or its hash. */
export const ApiKeyResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
});
export type ApiKeyResponseDto = z.infer<typeof ApiKeyResponseSchema>;

/** Returned once, on creation: `key` is never shown again. */
export const CreatedApiKeySchema = z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    key: z.string(),
    expiresAt: z.string().nullable(),
});
export type CreatedApiKeyDto = z.infer<typeof CreatedApiKeySchema>;
