import { BadRequestException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '../repo/repo.entity.js';
import { CreateProjectSchema, ReplaceProjectSchema, type ReplaceProjectDto } from './project.dto.js';
import { Project } from './project.entity.js';
import { ProjectMapper } from './project.mapper.js';
import { ProjectService } from './project.service.js';

let ds: DataSource;
let service: ProjectService;
let projects: Repository<Project>;
let p1: Project;
let p2: Project;
let ownRepo: Repo;
let foreignRepo: Repo;

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Project, Repo], synchronize: true }).initialize();
    projects = ds.getRepository(Project);
    const repos = ds.getRepository(Repo);
    service = new ProjectService(new ProjectMapper(), projects, repos);
    p1 = await projects.save({ slug: 'p1', name: 'P1' });
    p2 = await projects.save({ slug: 'p2', name: 'P2' });
    ownRepo = await repos.save(repos.create({ projectId: p1.id, fullName: 'o/own' }));
    foreignRepo = await repos.save(repos.create({ projectId: p2.id, fullName: 'o/foreign' }));
});
afterEach(() => ds.destroy());

/** A complete replacement body: the stored project's updatable fields with `over` applied. */
async function full(over: Partial<ReplaceProjectDto> = {}): Promise<ReplaceProjectDto> {
    const p = await service.getById(p1.id);
    return {
        name: p.name, description: p.description, dailyRunLimit: p.dailyRunLimit, maxAttempts: p.maxAttempts,
        runTimeoutMinutes: p.runTimeoutMinutes, retryOnChangesRequested: p.retryOnChangesRequested, autoFixConflicts: p.autoFixConflicts, autoPlan: p.autoPlan,
        skillsLibrary: p.skillsLibrary, skillsLibraryRepoId: p.skillsLibraryRepoId,
        dailyBudgetUsd: p.dailyBudgetUsd, weeklyBudgetUsd: p.weeklyBudgetUsd, budgetSoftPct: p.budgetSoftPct, ...over,
    };
}

const FULL_BODY = {
    name: 'N', description: null, dailyRunLimit: 10, maxAttempts: 3, runTimeoutMinutes: 60, retryOnChangesRequested: true, autoFixConflicts: false, autoPlan: false,
    skillsLibrary: 'none', skillsLibraryRepoId: null, dailyBudgetUsd: null, weeklyBudgetUsd: null, budgetSoftPct: 80,
};

describe('ProjectService skills library', () => {
    it('defaults to none', async () => {
        expect(await service.getById(p1.id)).toMatchObject({ skillsLibrary: 'none', skillsLibraryRepoId: null });
    });

    it('accepts a repo of the same project', async () => {
        const dto = await service.update(p1.id, await full({ skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id }));
        expect(dto).toMatchObject({ skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id });
    });

    it('rejects a repo of another project with 400', async () => {
        await expect(service.update(p1.id, await full({ skillsLibrary: 'repo', skillsLibraryRepoId: foreignRepo.id }))).rejects.toThrow(
            BadRequestException,
        );
    });

    it('does not recheck an unchanged repo library when another section is saved', async () => {
        await service.update(p1.id, await full({ skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id }));
        await ds.getRepository(Repo).update({ id: ownRepo.id }, { projectId: p2.id });
        expect(await service.update(p1.id, await full({ name: 'Renamed' }))).toMatchObject({ name: 'Renamed', skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id });
    });

    it('rejects repo without a repo id with 400', async () => {
        await expect(service.update(p1.id, await full({ skillsLibrary: 'repo', skillsLibraryRepoId: null }))).rejects.toThrow(BadRequestException);
    });

    it('clears the repo id when switching to another kind', async () => {
        await service.update(p1.id, await full({ skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id }));
        expect(await service.update(p1.id, await full({ skillsLibrary: 'folder' }))).toMatchObject({ skillsLibrary: 'folder', skillsLibraryRepoId: null });
    });

    it('cannot create a project with a repo library', async () => {
        await expect(service.create({ slug: 'p3', name: 'P3', skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id })).rejects.toThrow(
            BadRequestException,
        );
    });

    it('has no way to set the library folder through the API', () => {
        const body = { skillsLibrary: 'folder', skillsLibraryPath: '/etc', SKILLS_LIBRARY_PATH: '/etc' };
        const parsed = ReplaceProjectSchema.parse({ ...(FULL_BODY as object), ...body });
        expect(parsed).toMatchObject({ skillsLibrary: 'folder' });
        expect(parsed).not.toHaveProperty('skillsLibraryPath');
        expect(parsed).not.toHaveProperty('SKILLS_LIBRARY_PATH');
        expect(CreateProjectSchema.parse({ slug: 'ab', name: 'x', ...body })).not.toHaveProperty('skillsLibraryPath');
    });
});

describe('Project budget settings', () => {
    it('defaults to no limits and 80%', async () => {
        expect(await service.getById(p1.id)).toMatchObject({ dailyBudgetUsd: null, weeklyBudgetUsd: null, budgetSoftPct: 80 });
    });

    it('persists, raises, clears (null) and keeps resent limits', async () => {
        expect(await service.update(p1.id, await full({ dailyBudgetUsd: 12.5, weeklyBudgetUsd: 0, budgetSoftPct: 50 }))).toMatchObject({ dailyBudgetUsd: 12.5, weeklyBudgetUsd: 0, budgetSoftPct: 50 });
        expect(await service.update(p1.id, await full({ name: 'Renamed' }))).toMatchObject({ dailyBudgetUsd: 12.5, weeklyBudgetUsd: 0, budgetSoftPct: 50 });
        expect(await service.update(p1.id, await full({ dailyBudgetUsd: 20 }))).toMatchObject({ dailyBudgetUsd: 20, weeklyBudgetUsd: 0 });
        expect(await service.update(p1.id, await full({ dailyBudgetUsd: null, weeklyBudgetUsd: null }))).toMatchObject({ dailyBudgetUsd: null, weeklyBudgetUsd: null, budgetSoftPct: 50 });
        expect((await service.list()).find((p) => p.id === p1.id)).toMatchObject({ dailyBudgetUsd: null, budgetSoftPct: 50 });
    });

    it('creates with limits', async () => {
        expect(await service.create({ slug: 'p3', name: 'P3', dailyBudgetUsd: 5 })).toMatchObject({ dailyBudgetUsd: 5, weeklyBudgetUsd: null, budgetSoftPct: 80 });
    });

    it('validates limits and the percentage', () => {
        const check = (over: object) => ReplaceProjectSchema.safeParse({ ...FULL_BODY, ...over }).success;
        for (const bad of [{ dailyBudgetUsd: -1 }, { weeklyBudgetUsd: Number.NaN }, { dailyBudgetUsd: Number.POSITIVE_INFINITY }, { dailyBudgetUsd: '5' }, { budgetSoftPct: 0 }, { budgetSoftPct: 100.1 }, { budgetSoftPct: null }, { budgetSoftPct: -5 }]) {
            expect(check(bad), JSON.stringify(bad)).toBe(false);
        }
        for (const good of [{ dailyBudgetUsd: 0 }, { weeklyBudgetUsd: null }, { budgetSoftPct: 100 }, { budgetSoftPct: 0.5 }, {}]) {
            expect(check(good), JSON.stringify(good)).toBe(true);
        }
        expect(CreateProjectSchema.safeParse({ slug: 'ok-1', name: 'n', dailyBudgetUsd: -0.01 }).success).toBe(false);
        expect(ReplaceProjectSchema.safeParse({}).success).toBe(false);
    });
});
