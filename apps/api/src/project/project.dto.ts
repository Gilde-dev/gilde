import { z } from 'zod';

const slug = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Lowercase letters, digits and dashes, 2–63 characters');

export const CreateProjectSchema = z.object({
    slug,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).nullable().optional(),
    dailyRunLimit: z.number().int().min(1).max(500).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    runTimeoutMinutes: z.number().int().min(5).max(24 * 60).optional(),
    retryOnChangesRequested: z.boolean().optional(),
});

export const UpdateProjectSchema = CreateProjectSchema.omit({ slug: true }).partial();

export const ProjectResponseSchema = z.object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    dailyRunLimit: z.number().int(),
    maxAttempts: z.number().int(),
    runTimeoutMinutes: z.number().int(),
    retryOnChangesRequested: z.boolean(),
    paused: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CreateProjectDto = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectDto = z.infer<typeof UpdateProjectSchema>;
export type ProjectResponseDto = z.infer<typeof ProjectResponseSchema>;