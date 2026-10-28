import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { RepoSkill } from '../skill/repo-skills.js';

export const RunContextSkillSchema = z.object({
    name: z.string(),
    /** sha256 of the skill folder's files in path order. */
    hash: z.string(),
    /** The skill's managed-by value; null for repo-owned skills. */
    managedBy: z.string().nullable(),
});

/** What the agent had when its run was fired: the repo's default branch at that moment. */
export const RunContextSchema = z.object({
    gildeboekVersion: z.string().nullable(),
    skills: z.array(RunContextSkillSchema),
    agentsMdHash: z.string().nullable(),
    capturedAt: z.string().datetime(),
});

export type RunContext = z.infer<typeof RunContextSchema>;

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

export const hashText = sha256;

/** Hash of a skill folder: its files sorted by path, so the order of the directory listing does not matter. */
export function hashSkillFiles(files: { path: string; content: string }[]): string {
    const hash = createHash('sha256');
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        hash.update(`${f.path.length}:${f.path}\n${Buffer.byteLength(f.content)}:`).update(f.content).update('\n');
    }
    return hash.digest('hex');
}

export function buildRunContext(input: {
    skills: RepoSkill[];
    gildeboekVersion: string | null;
    agentsMd: string | null;
    capturedAt: Date;
}): RunContext {
    return {
        gildeboekVersion: input.gildeboekVersion,
        skills: [...input.skills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => ({ name: s.name, hash: hashSkillFiles(s.files), managedBy: s.managedBy })),
        agentsMdHash: input.agentsMd === null ? null : sha256(input.agentsMd),
        capturedAt: input.capturedAt.toISOString(),
    };
}
