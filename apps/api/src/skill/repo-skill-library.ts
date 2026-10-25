import { ServiceUnavailableException } from '@nestjs/common';

import type { GitHubPort } from '../github/github.port.js';

import { buildCatalog, REGISTRY_FILE, type CatalogSkill, type SkillFile, type SkillLibrary } from './skill-library.js';

export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Reads a library from a repo's default branch through the GitHub port. Cached for 5 minutes. */
export class RepoSkillLibrary implements SkillLibrary {
    private cached: { at: number; catalog: CatalogSkill[] } | null = null;

    constructor(
        private readonly github: GitHubPort,
        private readonly repo: { fullName: string; defaultBranch: string },
        private readonly now: () => number = Date.now,
    ) { }

    async getCatalog(): Promise<CatalogSkill[]> {
        if (this.cached && this.now() - this.cached.at < CACHE_TTL_MS) return this.cached.catalog;
        const { fullName, defaultBranch } = this.repo;
        const registry = await this.github.getFileContent(fullName, REGISTRY_FILE, defaultBranch);
        if (!registry) throw new ServiceUnavailableException(`${fullName} has no ${REGISTRY_FILE} on ${defaultBranch}`);
        const catalog = await buildCatalog(registry.content, (name) => this.readSkillFiles(`skills/${name}`));
        this.cached = { at: this.now(), catalog };
        return catalog;
    }

    invalidate(): void {
        this.cached = null;
    }

    private async readSkillFiles(base: string): Promise<SkillFile[]> {
        return readTree(this.github, this.repo.fullName, this.repo.defaultBranch, base);
    }
}

/** All files below `base` in a repo, with paths relative to `base`. A missing folder is empty. */
export async function readTree(github: GitHubPort, fullName: string, ref: string, base: string): Promise<SkillFile[]> {
    const entries = (await github.listDirectory(fullName, base, ref)) ?? [];
    const files: SkillFile[] = [];
    for (const entry of entries) {
        if (entry.type === 'dir') {
            for (const f of await readTree(github, fullName, ref, entry.path)) files.push({ ...f, path: `${entry.name}/${f.path}` });
        } else {
            const file = await github.getFileContent(fullName, entry.path, ref);
            if (file) files.push({ path: entry.name, content: file.content });
        }
    }
    return files;
}
