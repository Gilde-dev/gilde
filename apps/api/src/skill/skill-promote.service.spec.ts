import { BadRequestException, ConflictException } from '@nestjs/common';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobService } from '../job/job.service.js';
import type { ProjectService } from '../project/project.service.js';
import type { RepoService } from '../repo/repo.service.js';

import { FolderSkillLibrary } from './folder-skill-library.js';
import { PromoteSkillSchema } from './skill.dto.js';
import { SkillPromoteService } from './skill-promote.service.js';
import type { RepoSkill, RepoSkillsReader } from './repo-skills.js';
import type { SkillLibraryResolver } from './skill-library.resolver.js';
import type { CatalogSkill } from './skill-library.js';

const SKILL_MD = '---\nname: mine\ndescription: My skill\n---\nBody with ``` fence\n';
const mine = (over: Partial<RepoSkill> = {}): RepoSkill => ({
    name: 'mine', description: 'My skill', source: 'repo', managedBy: null,
    files: [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'scripts/run.sh', content: 'echo hi\n' }], ...over,
});

let dir: string;
let project: { id: string; skillsLibrary: string; skillsLibraryRepoId: string | null };
let repoSkills: RepoSkill[];
let catalog: CatalogSkill[];
let kind: 'folder' | 'repo';
let jobs: { create: ReturnType<typeof vi.fn> };

const repo = { id: 'r1', projectId: 'p1', fullName: 'o/app', stacks: ['nestjs'], skills: null as { include?: string[]; exclude?: string[] } | null };

const service = () => {
    const folder = new FolderSkillLibrary(dir);
    const library = kind === 'folder' ? folder : { getCatalog: async () => catalog, invalidate: () => undefined };
    return new SkillPromoteService(
        { getById: async () => project } as unknown as ProjectService,
        { getById: async () => repo } as unknown as RepoService,
        { resolve: async () => ({ kind, repoFullName: null, library: kind === 'folder' ? folder : library }) } as unknown as SkillLibraryResolver,
        jobs as unknown as JobService,
        { read: async () => repoSkills } as unknown as RepoSkillsReader,
    );
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'promote-'));
    project = { id: 'p1', skillsLibrary: 'repo', skillsLibraryRepoId: 'lib' };
    repoSkills = [mine()];
    catalog = [{ name: 'alpha', description: 'a', scope: 'global', stacks: [], files: [] }];
    kind = 'repo';
    repo.skills = null;
    let n = 0;
    jobs = { create: vi.fn(async () => ({ id: `job-${++n}` })) };
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('PromoteSkillSchema', () => {
    it('needs stacks for a stack scope, from STACKS', () => {
        expect(PromoteSkillSchema.safeParse({ scope: 'stack' }).success).toBe(false);
        expect(PromoteSkillSchema.safeParse({ scope: 'stack', stacks: [] }).success).toBe(false);
        expect(PromoteSkillSchema.safeParse({ scope: 'stack', stacks: ['nope'] }).success).toBe(false);
        expect(PromoteSkillSchema.safeParse({ scope: 'stack', stacks: ['nestjs'] }).success).toBe(true);
        expect(PromoteSkillSchema.safeParse({ scope: 'global' }).success).toBe(true);
    });
});

describe('SkillPromoteService with a repo library', () => {
    it('creates job A on the library repo with the files embedded, and job B depending on A', async () => {
        const res = await service().promote('r1', 'mine', { scope: 'stack', stacks: ['nestjs'] });
        expect(res).toEqual({ libraryJobId: 'job-1', cleanupJobId: 'job-2' });

        const [libRepo, a] = jobs.create.mock.calls[0];
        expect(libRepo).toBe('lib');
        expect(a.task).toContain('skills/mine/');
        expect(a.task).toContain('File: SKILL.md');
        expect(a.task).toContain('Body with ``` fence');
        expect(a.task).toContain('File: scripts/run.sh\n```\necho hi\n\n```');
        expect(a.task).toContain('scope stack and stacks [nestjs]');
        expect(a.task).toContain('AGENTS.md');
        expect(a.task).toContain('test commands');
        expect(a.dependsOn).toBeUndefined();

        const [srcRepo, b] = jobs.create.mock.calls[1];
        expect(srcRepo).toBe('r1');
        expect(b.dependsOn).toEqual(['job-1']);
        expect(b.task).toContain('.claude/skills/mine/');
        expect(b.task).toContain('explicitly allows changing .claude/skills/mine/ and .gilde.json');
    });

    it('asks B to add the name to skills.include unless the manifest already gets it', async () => {
        await service().promote('r1', 'mine', { scope: 'global' });
        expect(jobs.create.mock.calls[1][1].task).toContain('leave .gilde.json unchanged');
        jobs.create.mockClear();
        await service().promote('r1', 'mine', { scope: 'stack', stacks: ['spring-boot'] });
        expect(jobs.create.mock.calls[1][1].task).toContain("Add 'mine' to skills.include");
    });

    it('409s for managed skills, names already in the library, and projects without a library', async () => {
        repoSkills = [mine({ source: 'managed', managedBy: 'lib@1' })];
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toBeInstanceOf(ConflictException);
        repoSkills = [mine()];
        catalog.push({ name: 'mine', description: 'x', scope: 'global', stacks: [], files: [] });
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toBeInstanceOf(ConflictException);
        project.skillsLibrary = 'none';
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toBeInstanceOf(ConflictException);
        expect(jobs.create).not.toHaveBeenCalled();
    });

    it('400s for skills over 30000 characters', async () => {
        const sized = (n: number) => SKILL_MD + 'x'.repeat(n - SKILL_MD.length);
        repoSkills = [mine({ files: [{ path: 'SKILL.md', content: sized(30_001) }] })];
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toBeInstanceOf(BadRequestException);
        repoSkills = [mine({ files: [{ path: 'SKILL.md', content: sized(30_000) }] })];
        await expect(service().promote('r1', 'mine', { scope: 'global' })).resolves.toBeDefined();
    });
    it('400s for names the library would reject, before reading anything', async () => {
        for (const bad of ['My_Skill', '.hidden', 'a b', 'x/y']) {
            repoSkills = [mine({ name: bad })];
            await expect(service().promote('r1', bad, { scope: 'global' })).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(jobs.create).not.toHaveBeenCalled();
    });

    it('400s when SKILL.md frontmatter name differs from the folder or the description is missing', async () => {
        repoSkills = [mine({ files: [{ path: 'SKILL.md', content: '---\nname: other\ndescription: d\n---\n' }] })];
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toThrow(/name: mine/);
        repoSkills = [mine({ files: [{ path: 'SKILL.md', content: '---\nname: mine\n---\n' }] })];
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toThrow(/description/);
        repoSkills = [mine({ files: [{ path: 'SKILL.md', content: 'no frontmatter' }] })];
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toBeInstanceOf(BadRequestException);
        expect(jobs.create).not.toHaveBeenCalled();
    });
});

describe('SkillPromoteService with a folder library', () => {
    beforeEach(async () => {
        kind = 'folder';
        project.skillsLibrary = 'folder';
        const registry = '# my library\nskills:\n  # first\n  - name: alpha\n    scope: global\n';
        await writeFile(join(dir, 'registry.yaml'), registry);
        await mkdir(join(dir, 'skills/alpha'), { recursive: true });
        await writeFile(join(dir, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: A\n---\n');
        catalog = [];
    });

    it('writes the files and registry entry (comments kept) and creates only job B', async () => {
        const res = await service().promote('r1', 'mine', { scope: 'stack', stacks: ['nestjs', 'nextjs'] });
        expect(res).toEqual({ libraryJobId: null, cleanupJobId: 'job-1' });
        expect(jobs.create).toHaveBeenCalledTimes(1);
        expect(jobs.create.mock.calls[0][1].dependsOn).toBeUndefined();

        expect(await readFile(join(dir, 'skills/mine/SKILL.md'), 'utf8')).toBe(SKILL_MD);
        expect(await readFile(join(dir, 'skills/mine/scripts/run.sh'), 'utf8')).toBe('echo hi\n');
        const registry = await readFile(join(dir, 'registry.yaml'), 'utf8');
        expect(registry).toContain('# my library');
        expect(registry).toContain('# first');
        expect(registry.indexOf('alpha')).toBeLessThan(registry.indexOf('mine'));
        expect(registry).toMatch(/name: mine\s+scope: stack\s+stacks:\s+- nestjs\s+- nextjs/);
        // the library still loads, with the new skill in it
        expect((await new FolderSkillLibrary(dir).getCatalog()).map((s) => s.name)).toEqual(['alpha', 'mine']);
    });

    it('refuses an existing folder (409) without touching the registry', async () => {
        await mkdir(join(dir, 'skills/mine'), { recursive: true });
        const before = await readFile(join(dir, 'registry.yaml'), 'utf8');
        await expect(service().promote('r1', 'mine', { scope: 'global' })).rejects.toBeInstanceOf(ConflictException);
        expect(await readFile(join(dir, 'registry.yaml'), 'utf8')).toBe(before);
        expect(jobs.create).not.toHaveBeenCalled();
    });

    it('rejects names and file paths that resolve outside the library folder', async () => {
        const lib = new FolderSkillLibrary(dir);
        await expect(lib.addSkill({ name: '..', scope: 'global' }, [])).rejects.toBeInstanceOf(BadRequestException);
        await expect(lib.addSkill({ name: 'x/../../y', scope: 'global' }, [])).rejects.toBeInstanceOf(BadRequestException);
        await expect(lib.addSkill({ name: 'ok', scope: 'global' }, [{ path: '../../evil.txt', content: 'x' }])).rejects.toBeInstanceOf(BadRequestException);
        await expect(stat(join(dir, '..', 'evil.txt'))).rejects.toThrow();
        await expect(stat(join(dir, 'skills/ok'))).rejects.toThrow();
        expect(await readFile(join(dir, 'registry.yaml'), 'utf8')).not.toContain('ok');
    });
});

