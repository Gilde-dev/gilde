import { ServiceUnavailableException } from '@nestjs/common';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCatalog, REGISTRY_FILE, type CatalogSkill, type SkillFile, type SkillLibrary } from './skill-library.js';

/** Reads a library from a folder on the server. Reloads when a file's mtime or size changed. Read-only. */
export class FolderSkillLibrary implements SkillLibrary {
    private cached: { signature: string; catalog: CatalogSkill[] } | null = null;

    constructor(private readonly root: string) { }

    async getCatalog(): Promise<CatalogSkill[]> {
        let signature: string;
        try {
            signature = await this.signature();
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new ServiceUnavailableException(`Skills library folder has no ${REGISTRY_FILE}`);
            }
            throw e;
        }
        if (this.cached?.signature === signature) return this.cached.catalog;
        const catalog = await buildCatalog(await readFile(join(this.root, REGISTRY_FILE), 'utf8'), (name) =>
            this.readSkillFiles(name),
        );
        this.cached = { signature, catalog };
        return catalog;
    }

    invalidate(): void {
        this.cached = null;
    }

    private async signature(): Promise<string> {
        const parts: string[] = [];
        const registry = await stat(join(this.root, REGISTRY_FILE));
        parts.push(`${REGISTRY_FILE}:${registry.mtimeMs}:${registry.size}`);
        for (const rel of await this.walk('skills')) {
            const s = await stat(join(this.root, rel));
            parts.push(`${rel}:${s.mtimeMs}:${s.size}`);
        }
        return parts.join('|');
    }

    /** Paths of all files below `dir` (relative to the root), sorted. A missing folder is empty. */
    private async walk(dir: string): Promise<string[]> {
        let entries;
        try {
            entries = await readdir(join(this.root, dir), { withFileTypes: true });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw e;
        }
        const out: string[] = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const rel = `${dir}/${entry.name}`;
            if (entry.isDirectory()) out.push(...(await this.walk(rel)));
            else if (entry.isFile()) out.push(rel);
        }
        return out;
    }

    private async readSkillFiles(name: string): Promise<SkillFile[]> {
        const base = `skills/${name}`;
        const paths = await this.walk(base);
        return Promise.all(
            paths.map(async (rel) => ({ path: rel.slice(base.length + 1), content: await readFile(join(this.root, rel), 'utf8') })),
        );
    }
}
