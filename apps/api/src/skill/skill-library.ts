import { ServiceUnavailableException } from '@nestjs/common';
import { parse } from 'yaml';
import { z } from 'zod';

export const SKILL_ENTRY = 'SKILL.md';
export const REGISTRY_FILE = 'registry.yaml';

export interface SkillFile {
    /** Relative to the skill folder, e.g. SKILL.md or scripts/run.sh. */
    path: string;
    content: string;
}

export interface CatalogSkill {
    name: string;
    description: string;
    scope: 'global' | 'stack';
    stacks: string[];
    files: SkillFile[];
}

/** A source of skills. This interface only reads; the one write path is FolderSkillLibrary.addSkill. */
export interface SkillLibrary {
    getCatalog(): Promise<CatalogSkill[]>;
    /** Drops cached state so the next getCatalog() reads the source again. */
    invalidate(): void;
}

/** Skill names become folder names, so they can't contain path separators or dots at the start. */
export const skillName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use lowercase letters, digits, dots, dashes and underscores');

const RegistrySchema = z.object({
    skills: z.array(
        z.object({
            name: skillName,
            scope: z.enum(['global', 'stack']),
            stacks: z.array(z.string()).optional(),
        }),
    ),
});

export type Registry = z.infer<typeof RegistrySchema>;

/** Splits a markdown file into its YAML frontmatter (parsed) and the raw frontmatter text. */
export function parseFrontmatter(content: string): { data: Record<string, unknown>; raw: string } | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) return null;
    try {
        const data = parse(match[1]) as unknown;
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
        return { data: data as Record<string, unknown>, raw: match[1] };
    } catch {
        return null;
    }
}

export function parseRegistry(text: string): Registry {
    let json: unknown;
    try {
        json = parse(text);
    } catch (e) {
        throw new ServiceUnavailableException(`${REGISTRY_FILE} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = RegistrySchema.safeParse(json);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        throw new ServiceUnavailableException(`${REGISTRY_FILE} is invalid: ${issues}`);
    }
    return parsed.data;
}

/**
 * Builds the catalog from registry.yaml and a reader for each skill's files. Both library kinds go through
 * here so the same content always gives the same catalog.
 */
export async function buildCatalog(
    registryText: string,
    readSkillFiles: (name: string) => Promise<SkillFile[]>,
): Promise<CatalogSkill[]> {
    const registry = parseRegistry(registryText);
    const catalog: CatalogSkill[] = [];
    for (const entry of registry.skills) {
        const files = (await readSkillFiles(entry.name)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const skillMd = files.find((f) => f.path === SKILL_ENTRY);
        if (!skillMd) throw new ServiceUnavailableException(`Skill '${entry.name}' has no ${SKILL_ENTRY}`);
        const meta = parseFrontmatter(skillMd.content)?.data;
        if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string') {
            throw new ServiceUnavailableException(`Skill '${entry.name}': ${SKILL_ENTRY} needs frontmatter with name and description`);
        }
        if (meta.name !== entry.name) {
            throw new ServiceUnavailableException(`Skill '${entry.name}': frontmatter name is '${meta.name}'`);
        }
        catalog.push({ name: entry.name, description: meta.description, scope: entry.scope, stacks: entry.stacks ?? [], files });
    }
    return catalog;
}
