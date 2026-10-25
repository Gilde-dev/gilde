import type { GitHubPort } from '../github/github.port.js';

import { readTree } from './repo-skill-library.js';
import { parseFrontmatter, SKILL_ENTRY, type CatalogSkill, type SkillFile } from './skill-library.js';

export const REPO_SKILLS_DIR = '.claude/skills';
export const MANAGED_BY_KEY = 'managed-by';
export const CACHE_TTL_MS = 5 * 60 * 1000;

export interface RepoSkill {
    name: string;
    description: string | null;
    source: 'managed' | 'repo';
    /** The managed-by value, opaque. */
    managedBy: string | null;
    files: SkillFile[];
}

export const SKILL_STATUSES = ['ok', 'outdated', 'missing', 'orphaned', 'conflict', 'repo'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export interface SkillDrift {
    name: string;
    description: string | null;
    source: 'managed' | 'repo' | null;
    managedBy: string | null;
    status: SkillStatus;
}

/** Lists the skills in a repo's .claude/skills on its default branch. Cached per repo for 5 minutes. */
export class RepoSkillsReader {
    private readonly cache = new Map<string, { at: number; skills: RepoSkill[] }>();

    constructor(
        private readonly github: GitHubPort,
        private readonly now: () => number = Date.now,
    ) { }

    async read(repo: { id: string; fullName: string; defaultBranch: string }): Promise<RepoSkill[]> {
        const key = `${repo.id}:${repo.fullName}:${repo.defaultBranch}`;
        const hit = this.cache.get(key);
        if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.skills;
        const entries = (await this.github.listDirectory(repo.fullName, REPO_SKILLS_DIR, repo.defaultBranch)) ?? [];
        const skills: RepoSkill[] = [];
        for (const entry of entries.filter((e) => e.type === 'dir')) {
            const files = await readTree(this.github, repo.fullName, repo.defaultBranch, entry.path);
            skills.push(classify(entry.name, files));
        }
        skills.sort((a, b) => a.name.localeCompare(b.name));
        this.cache.set(key, { at: this.now(), skills });
        return skills;
    }

    invalidate(repoId: string): void {
        for (const key of this.cache.keys()) if (key.startsWith(`${repoId}:`)) this.cache.delete(key);
    }
}

function classify(name: string, files: SkillFile[]): RepoSkill {
    const meta = parseFrontmatter(files.find((f) => f.path === SKILL_ENTRY)?.content ?? '')?.data;
    const managedBy = meta?.[MANAGED_BY_KEY];
    return {
        name,
        description: typeof meta?.description === 'string' ? meta.description : null,
        source: managedBy === undefined || managedBy === null ? 'repo' : 'managed',
        managedBy: managedBy === undefined || managedBy === null ? null : typeof managedBy === 'string' ? managedBy : JSON.stringify(managedBy),
        files,
    };
}

/** SKILL.md without its managed-by line; other files untouched. */
function normalized(file: SkillFile): string {
    return file.path === SKILL_ENTRY ? file.content.replace(/^managed-by:.*(?:\r?\n|$)/m, '') : file.content;
}

export function sameFiles(library: SkillFile[], repo: SkillFile[]): boolean {
    if (library.length !== repo.length) return false;
    const byPath = new Map(repo.map((f) => [f.path, f]));
    return library.every((f) => {
        const other = byPath.get(f.path);
        return other !== undefined && normalized(other) === normalized(f);
    });
}

/** One status per skill name, comparing the repo's skills with what the library says it should have. */
export function computeDrift(desired: string[], catalog: CatalogSkill[], present: RepoSkill[]): SkillDrift[] {
    const library = new Map(catalog.map((s) => [s.name, s]));
    const wanted = new Set(desired.filter((n) => library.has(n)));
    const repoByName = new Map(present.map((s) => [s.name, s]));
    const out: SkillDrift[] = [];

    for (const name of wanted) {
        const lib = library.get(name)!;
        const have = repoByName.get(name);
        if (!have) out.push({ name, description: lib.description, source: null, managedBy: null, status: 'missing' });
        else if (have.source === 'repo') out.push(entry(have, 'conflict'));
        else out.push(entry(have, sameFiles(lib.files, have.files) ? 'ok' : 'outdated'));
    }
    for (const have of present) {
        if (wanted.has(have.name)) continue;
        out.push(entry(have, have.source === 'managed' ? 'orphaned' : 'repo'));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

const entry = (s: RepoSkill, status: SkillStatus): SkillDrift => ({
    name: s.name,
    description: s.description,
    source: s.source,
    managedBy: s.managedBy,
    status,
});

export function countStatuses(skills: SkillDrift[]): Record<SkillStatus, number> {
    const counts = Object.fromEntries(SKILL_STATUSES.map((s) => [s, 0])) as Record<SkillStatus, number>;
    for (const s of skills) counts[s.status]++;
    return counts;
}
