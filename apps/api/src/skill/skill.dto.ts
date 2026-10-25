import { z } from 'zod';

import { STACKS } from '../repo/repo.entity.js';
import { SKILL_STATUSES } from './repo-skills.js';

export const SkillCatalogResponseSchema = z.object({
    library: z.object({ kind: z.enum(['folder', 'repo']), repoFullName: z.string().nullable() }),
    skills: z.array(
        z.object({
            name: z.string(),
            description: z.string(),
            scope: z.enum(['global', 'stack']),
            stacks: z.array(z.string()),
            files: z.array(z.string()),
            repos: z.array(z.object({ id: z.string().uuid(), fullName: z.string() })),
        }),
    ),
});

export const RepoSkillsResponseSchema = z.object({
    repoId: z.string().uuid(),
    skills: z.array(
        z.object({
            name: z.string(),
            description: z.string().nullable(),
            source: z.enum(['managed', 'repo']).nullable(),
            managedBy: z.string().nullable(),
            status: z.enum(SKILL_STATUSES),
        }),
    ),
    counts: z.record(z.enum(SKILL_STATUSES), z.number().int()),
});

export type SkillCatalogResponseDto = z.infer<typeof SkillCatalogResponseSchema>;
export type RepoSkillsResponseDto = z.infer<typeof RepoSkillsResponseSchema>;

/** Skill files total at most this many characters to be promoted. */
export const MAX_PROMOTE_CHARS = 30_000;

export const PromoteSkillSchema = z.object({
    scope: z.enum(['global', 'stack']),
    stacks: z.array(z.enum(STACKS)).optional(),
}).superRefine((v, ctx) => {
    if (v.scope === 'stack' && !v.stacks?.length) {
        ctx.addIssue({ code: 'custom', path: ['stacks'], message: 'Choose at least one stack for a stack scope' });
    }
});

export interface PromoteSkillResponseDto {
    /** The job that adds the skill to the library repo; null when the library is a folder. */
    libraryJobId: string | null;
    cleanupJobId: string;
}

export type PromoteSkillDto = z.infer<typeof PromoteSkillSchema>;
