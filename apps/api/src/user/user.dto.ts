import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 12;

export const CreateUserSchema = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().max(255).pipe(z.email()),
    password: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`).max(1024),
});

export const UserResponseSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
});

/** Persisted identity used for human-only decisions; kept apart from UserResponseDto, which clients already rely on. */
export const UserIdentitySchema = z.object({
    id: z.string().uuid(),
    email: z.string(),
    isBot: z.boolean(),
});

export type CreateUserDto = z.infer<typeof CreateUserSchema>;
export type UserResponseDto = z.infer<typeof UserResponseSchema>;
export type UserIdentityDto = z.infer<typeof UserIdentitySchema>;
