import { NotFoundException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitHubFile, GitHubPort } from '../github/github.port.js';
import { Project } from '../project/project.entity.js';
import { Repo } from './repo.entity.js';
import { RepoMapper } from './repo.mapper.js';
import { RepoManifestService } from './repo-manifest.service.js';

let ds: DataSource;
let repos: Repository<Repo>;
let repo: Repo;
let file: GitHubFile | null | Error;
let service: RepoManifestService;

const manifest = (over: object = {}) => JSON.stringify({ stacks: ['nestjs', 'nextjs'], testCommands: ['pnpm test'], skills: { include: ['x'] }, ...over });

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Project, Repo], synchronize: true }).initialize();
    repos = ds.getRepository(Repo);
    const project = await ds.getRepository(Project).save({ slug: 'p', name: 'P' });
    repo = await repos.save(repos.create({ projectId: project.id, fullName: 'o/r' }));
    file = null;
    const github = {
        isConfigured: () => true,
        getFileContent: async () => { if (file instanceof Error) throw file; return file; },
    } as unknown as GitHubPort;
    service = new RepoManifestService(new RepoMapper(), repos, github);
});

afterEach(() => ds.destroy());

describe('RepoManifestService.refresh', () => {
    it('caches values and sha', async () => {
        file = { content: manifest(), sha: 'abc' };
        const dto = await service.refresh(repo.id);
        expect(dto).toMatchObject({
            stacks: ['nestjs', 'nextjs'], testCommands: ['pnpm test'], skills: { include: ['x'] },
            manifestSha: 'abc', manifestError: null,
        });
        expect(dto.manifestSyncedAt).not.toBeNull();
        expect(await repos.findOneByOrFail({ id: repo.id })).toMatchObject({ testCommands: ['pnpm test'], manifestSha: 'abc' });
    });

    it.each([
        ['a missing file', null, /not found/],
        ['invalid JSON', { content: '{nope', sha: 'x' }, /not valid JSON/],
        ['an invalid manifest', { content: manifest({ stacks: [] }), sha: 'x' }, /stacks/],
        ['a GitHub error', new Error('boom'), /boom/],
    ])('%s sets manifestError and keeps the previous values', async (_name, next, message) => {
        file = { content: manifest(), sha: 'good' };
        await service.refresh(repo.id);
        file = next as GitHubFile | null | Error;
        const dto = await service.refresh(repo.id);
        expect(dto.manifestError).toMatch(message);
        expect(dto).toMatchObject({ stacks: ['nestjs', 'nextjs'], testCommands: ['pnpm test'], manifestSha: 'good' });
    });

    it('clears the error on the next good refresh', async () => {
        await service.refresh(repo.id);
        expect((await repos.findOneByOrFail({ id: repo.id })).manifestError).toMatch(/not found/);
        file = { content: manifest(), sha: 'abc' };
        expect((await service.refresh(repo.id)).manifestError).toBeNull();
    });

    it('404s for an unknown repo and refreshQuietly swallows it', async () => {
        const id = '00000000-0000-4000-8000-000000000000';
        await expect(service.refresh(id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.refreshQuietly(id)).resolves.toBeUndefined();
    });
});
