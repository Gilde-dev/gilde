import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';

import { buildCatalog, REGISTRY_FILE, skillName, type CatalogSkill, type SkillFile, type SkillLibrary } from './skill-library.js';

/**
 * Reads a library from a folder on the server. Reloads when a file's mtime or size changed.
 * Reading only, except addSkill: the single place Gilde writes to the library folder.
 */
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

    /**
     * Writes skills/<name>/ and appends a registry.yaml entry. Existing registry comments and order are kept.
     * Refuses an existing skill folder (409) and any path that would end up outside the library folder (400).
     */
    async addSkill(
        entry: { name: string; scope: 'global' | 'stack'; stacks?: string[] },
        files: SkillFile[],
    ): Promise<void> {
        if (!skillName.safeParse(entry.name).success) throw new BadRequestException(`Invalid skill name '${entry.name}'`);
        const root = resolve(this.root);
        const skillsDir = join(root, 'skills');
        const dir = resolve(skillsDir, entry.name);
        const inside = (base: string, p: string) => p !== base && p.startsWith(base + sep);
        if (!inside(skillsDir, dir)) throw new BadRequestException(`Skill '${entry.name}' resolves outside the library folder`);
        const targets = files.map((f) => {
            const target = resolve(dir, f.path);
            if (!inside(dir, target)) throw new BadRequestException(`File '${f.path}' resolves outside the library folder`);
            return { target, content: f.content };
        });
        if (await exists(dir)) throw new ConflictException(`The library already has a skills/${entry.name} folder`);

        const registryPath = join(root, REGISTRY_FILE);
        const doc = parseDocument(await readFile(registryPath, 'utf8'));
        doc.addIn(['skills'], doc.createNode(entry.scope === 'stack' ? { name: entry.name, scope: entry.scope, stacks: entry.stacks ?? [] } : { name: entry.name, scope: entry.scope }));

        try {
            for (const t of targets) {
                await mkdir(dirname(t.target), { recursive: true });
                await writeFile(t.target, t.content, 'utf8');
            }
            await writeFile(registryPath, doc.toString(), 'utf8');
        } catch (e) {
            await rm(dir, { recursive: true, force: true });
            throw e;
        }
        this.invalidate();
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

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw e;
    }
}
