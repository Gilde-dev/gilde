import { z } from 'zod';

import { STACKS } from './repo.entity.js';

export const ManifestSkillsSchema = z.object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
});

/** The .gilde.json at a repo's root. Unknown keys are allowed (and dropped). */
export const ManifestSchema = z.object({
    name: z.string().optional(),
    stacks: z.array(z.enum(STACKS)).min(1),
    testCommands: z.array(z.string().min(1)).min(1),
    skills: ManifestSkillsSchema.optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
