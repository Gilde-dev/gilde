import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitHubPort } from '../github/github.port.js';
import type { RepoService } from '../repo/repo.service.js';

import { SkillLibraryResolver } from './skill-library.resolver.js';

const original = process.env.SKILLS_LIBRARY_PATH;
let dir: string;

const repoService = {
    getById: async (id: string) => {
        if (id === 'r1') return { id, projectId: 'p1', fullName: 'o/lib', defaultBranch: 'main' };
        if (id === 'other') return { id, projectId: 'p2', fullName: 'o/x', defaultBranch: 'main' };
        throw new NotFoundException();
    },
} as unknown as RepoService;
const resolver = () => new SkillLibraryResolver(repoService, {} as GitHubPort);

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resolver-'));
    delete process.env.SKILLS_LIBRARY_PATH;
});
afterEach(async () => {
    if (original === undefined) delete process.env.SKILLS_LIBRARY_PATH;
    else process.env.SKILLS_LIBRARY_PATH = original;
    await rm(dir, { recursive: true, force: true });
});

describe('SkillLibraryResolver', () => {
    it('none: 503 with a clear message', async () => {
        const p = resolver().resolve({ id: 'p1', skillsLibrary: 'none', skillsLibraryRepoId: null });
        await expect(p).rejects.toThrow(ServiceUnavailableException);
        await expect(p).rejects.toThrow(/no skills library configured/);
    });

    it('folder without SKILLS_LIBRARY_PATH: 503', async () => {
        await expect(resolver().resolve({ id: 'p1', skillsLibrary: 'folder', skillsLibraryRepoId: null })).rejects.toThrow(
            /SKILLS_LIBRARY_PATH is not set/,
        );
    });

    it('folder without registry.yaml: 503', async () => {
        process.env.SKILLS_LIBRARY_PATH = dir;
        await expect(resolver().resolve({ id: 'p1', skillsLibrary: 'folder', skillsLibraryRepoId: null })).rejects.toThrow(
            /has no registry.yaml/,
        );
    });

    it('folder with registry.yaml resolves', async () => {
        process.env.SKILLS_LIBRARY_PATH = dir;
        await writeFile(join(dir, 'registry.yaml'), 'skills: []\n');
        expect(await resolver().resolve({ id: 'p1', skillsLibrary: 'folder', skillsLibraryRepoId: null })).toMatchObject({ kind: 'folder' });
    });

    it('repo that is missing or belongs to another project: 503', async () => {
        const r = resolver();
        for (const skillsLibraryRepoId of [null, 'gone', 'other']) {
            await expect(r.resolve({ id: 'p1', skillsLibrary: 'repo', skillsLibraryRepoId })).rejects.toThrow(
                /not registered in this project/,
            );
        }
    });

    it('repo resolves and keeps the same instance', async () => {
        const r = resolver();
        const a = await r.resolve({ id: 'p1', skillsLibrary: 'repo', skillsLibraryRepoId: 'r1' });
        const b = await r.resolve({ id: 'p1', skillsLibrary: 'repo', skillsLibraryRepoId: 'r1' });
        expect(a).toMatchObject({ kind: 'repo', repoFullName: 'o/lib' });
        expect(a.library).toBe(b.library);
    });
});
