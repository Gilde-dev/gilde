import { z } from 'zod';

import { SKILLS_LIBRARY_KINDS } from './project.entity.js';

const slug = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Lowercase letters, digits and dashes, 2–63 characters');

/** Estimated USD: finite and >= 0 (0 stops immediately); null means no limit. */
const budgetLimit = z.number().finite().min(0).nullable();

export const CreateProjectSchema = z.object({
    slug,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).nullable().optional(),
    dailyRunLimit: z.number().int().min(1).max(500).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    runTimeoutMinutes: z.number().int().min(5).max(24 * 60).optional(),
    retryOnChangesRequested: z.boolean().optional(),
    autoFixConflicts: z.boolean().optional(),
    autoPlan: z.boolean().optional(),
    skillsLibrary: z.enum(SKILLS_LIBRARY_KINDS).optional(),
    skillsLibraryRepoId: z.string().uuid().nullable().optional(),
    dailyBudgetUsd: budgetLimit.optional(),
    weeklyBudgetUsd: budgetLimit.optional(),
    budgetSoftPct: z.number().finite().gt(0).max(100).optional(),
});

/** Full replacement of a project's settings (PUT). slug is the identity and paused has its own endpoints; nullable keys are required and null clears them. */
export const ReplaceProjectSchema = z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).nullable(),
    dailyRunLimit: z.number().int().min(1).max(500),
    maxAttempts: z.number().int().min(1).max(10),
    runTimeoutMinutes: z.number().int().min(5).max(24 * 60),
    retryOnChangesRequested: z.boolean(),
    autoFixConflicts: z.boolean(),
    autoPlan: z.boolean(),
    skillsLibrary: z.enum(SKILLS_LIBRARY_KINDS),
    skillsLibraryRepoId: z.string().uuid().nullable(),
    dailyBudgetUsd: budgetLimit,
    weeklyBudgetUsd: budgetLimit,
    budgetSoftPct: z.number().finite().gt(0).max(100),
});

export const ProjectResponseSchema = z.object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    dailyRunLimit: z.number().int(),
    maxAttempts: z.number().int(),
    runTimeoutMinutes: z.number().int(),
    retryOnChangesRequested: z.boolean(),
    autoFixConflicts: z.boolean(),
    autoPlan: z.boolean(),
    paused: z.boolean(),
    skillsLibrary: z.enum(SKILLS_LIBRARY_KINDS),
    skillsLibraryRepoId: z.string().uuid().nullable(),
    dailyBudgetUsd: z.number().nullable(),
    weeklyBudgetUsd: z.number().nullable(),
    budgetSoftPct: z.number(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CreateProjectDto = z.infer<typeof CreateProjectSchema>;
export type ReplaceProjectDto = z.infer<typeof ReplaceProjectSchema>;
export type ProjectResponseDto = z.infer<typeof ProjectResponseSchema>;