import { z } from 'zod';

export const MAX_EXPIRES_IN_DAYS = 3650;

export const CreateApiKeySchema = z.object({
    name: z.string().trim().min(1).max(100),
    expiresInDays: z.number().int().min(1).max(MAX_EXPIRES_IN_DAYS).optional(),
});

export type CreateApiKeyDto = z.infer<typeof CreateApiKeySchema>;

/** Listed keys never carry the secret or its hash. */
export interface ApiKeyResponseDto {
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
}

/** Returned once, on creation: `key` is never shown again. */
export interface CreatedApiKeyDto {
    id: string;
    name: string;
    prefix: string;
    key: string;
    expiresAt: string | null;
}
