import { ServiceUnavailableException } from '@nestjs/common';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitHubDirEntry, GitHubPort } from '../github/github.port.js';

import { LIBRARY_FILES } from './fixtures.js';
import { FolderSkillLibrary } from './folder-skill-library.js';
import { CACHE_TTL_MS, RepoSkillLibrary } from './repo-skill-library.js';

let dir: string;

async function writeTree(root: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
    }
}

async function snapshot(root: string): Promise<string> {
    const out: string[] = [];
    const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else out.push(`${p}:${(await stat(p)).mtimeMs}:${(await stat(p)).size}`);
        }
    };
    await walk(root);
    return out.sort().join('\n');
}

/** A GitHub port serving a path → content map, with a call counter. */
function fakeGithub(files: Record<string, string>) {
    const calls = { n: 0 };
    const github = {
        isConfigured: () => true,
        getFileContent: async (_f: string, path: string) => {
            calls.n++;
            return path in files ? { content: files[path], sha: 'x' } : null;
        },
        listDirectory: async (_f: string, path: string): Promise<GitHubDirEntry[] | null> => {
            calls.n++;
            const prefix = `${path}/`;
            const names = new Map<string, 'file' | 'dir'>();
            for (const p of Object.keys(files)) {
                if (!p.startsWith(prefix)) continue;
                const rest = p.slice(prefix.length);
                const [head] = rest.split('/');
                names.set(head, rest.includes('/') ? 'dir' : 'file');
            }
            if (names.size === 0) return null;
            return [...names].map(([name, type]) => ({ name, path: `${prefix}${name}`, type }));
        },
    } as unknown as GitHubPort;
    return { github, calls };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skills-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('FolderSkillLibrary', () => {
    it('parses registry and skills', async () => {
        await writeTree(dir, LIBRARY_FILES);
        const catalog = await new FolderSkillLibrary(dir).getCatalog();
        expect(catalog.map((s) => [s.name, s.description, s.scope, s.stacks])).toEqual([
            ['alpha', 'Alpha skill', 'global', []],
            ['beta', 'Beta skill', 'stack', ['nestjs']],
        ]);
        expect(catalog[1].files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
        expect(catalog[1].files[1].content).toBe('echo hi\n');
    });

    it('reloads after a file changed and not before', async () => {
        await writeTree(dir, LIBRARY_FILES);
        const lib = new FolderSkillLibrary(dir);
        const first = await lib.getCatalog();
        expect(await lib.getCatalog()).toBe(first);

        const file = join(dir, 'skills/alpha/SKILL.md');
        await writeFile(file, '---\nname: alpha\ndescription: Changed\n---\n');
        const later = new Date(Date.now() + 5000);
        await utimes(file, later, later);
        expect((await lib.getCatalog())[0].description).toBe('Changed');
    });

    it('never writes', async () => {
        await writeTree(dir, LIBRARY_FILES);
        const before = await snapshot(dir);
        const lib = new FolderSkillLibrary(dir);
        await lib.getCatalog();
        lib.invalidate();
        await lib.getCatalog();
        expect(await snapshot(dir)).toBe(before);
    });

    it('is unavailable without registry.yaml', async () => {
        await expect(new FolderSkillLibrary(dir).getCatalog()).rejects.toThrow(ServiceUnavailableException);
    });

    it('rejects a skill whose frontmatter lacks a description', async () => {
        await writeTree(dir, { ...LIBRARY_FILES, 'skills/alpha/SKILL.md': '---\nname: alpha\n---\n' });
        await expect(new FolderSkillLibrary(dir).getCatalog()).rejects.toThrow(/name and description/);
    });

    it('rejects registry names that could leave the skills folder', async () => {
        await writeTree(dir, { 'registry.yaml': 'skills:\n  - name: ../x\n    scope: global\n' });
        await expect(new FolderSkillLibrary(dir).getCatalog()).rejects.toThrow(/registry.yaml is invalid/);
    });
});

describe('RepoSkillLibrary', () => {
    const repo = { fullName: 'o/lib', defaultBranch: 'main' };

    it('returns the same catalog as the folder library for the same content', async () => {
        await writeTree(dir, LIBRARY_FILES);
        const fromFolder = await new FolderSkillLibrary(dir).getCatalog();
        const fromRepo = await new RepoSkillLibrary(fakeGithub(LIBRARY_FILES).github, repo).getCatalog();
        expect(fromRepo).toEqual(fromFolder);
    });

    it('caches for 5 minutes, then reads again', async () => {
        const { github, calls } = fakeGithub(LIBRARY_FILES);
        let now = 1_000;
        const lib = new RepoSkillLibrary(github, repo, () => now);
        await lib.getCatalog();
        const after = calls.n;
        now += CACHE_TTL_MS - 1;
        await lib.getCatalog();
        expect(calls.n).toBe(after);
        now += 2;
        await lib.getCatalog();
        expect(calls.n).toBeGreaterThan(after);
    });

    it('reads again after invalidate', async () => {
        const { github, calls } = fakeGithub(LIBRARY_FILES);
        const lib = new RepoSkillLibrary(github, repo);
        await lib.getCatalog();
        const after = calls.n;
        lib.invalidate();
        await lib.getCatalog();
        expect(calls.n).toBeGreaterThan(after);
    });

    it('is unavailable without registry.yaml', async () => {
        await expect(new RepoSkillLibrary(fakeGithub({}).github, repo).getCatalog()).rejects.toThrow(/no registry.yaml/);
    });
});
