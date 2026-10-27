import { BadRequestException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '../repo/repo.entity.js';
import { CreateProjectSchema, UpdateProjectSchema } from './project.dto.js';
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

describe('ProjectService skills library', () => {
    it('defaults to none', async () => {
        expect(await service.getById(p1.id)).toMatchObject({ skillsLibrary: 'none', skillsLibraryRepoId: null });
    });

    it('accepts a repo of the same project', async () => {
        const dto = await service.update(p1.id, { skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id });
        expect(dto).toMatchObject({ skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id });
    });

    it('rejects a repo of another project with 400', async () => {
        await expect(service.update(p1.id, { skillsLibrary: 'repo', skillsLibraryRepoId: foreignRepo.id })).rejects.toThrow(
            BadRequestException,
        );
    });

    it('rejects repo without a repo id with 400', async () => {
        await expect(service.update(p1.id, { skillsLibrary: 'repo' })).rejects.toThrow(BadRequestException);
    });

    it('clears the repo id when switching to another kind', async () => {
        await service.update(p1.id, { skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id });
        expect(await service.update(p1.id, { skillsLibrary: 'folder' })).toMatchObject({ skillsLibrary: 'folder', skillsLibraryRepoId: null });
    });

    it('cannot create a project with a repo library', async () => {
        await expect(service.create({ slug: 'p3', name: 'P3', skillsLibrary: 'repo', skillsLibraryRepoId: ownRepo.id })).rejects.toThrow(
            BadRequestException,
        );
    });

    it('has no way to set the library folder through the API', () => {
        const body = { skillsLibrary: 'folder', skillsLibraryPath: '/etc', SKILLS_LIBRARY_PATH: '/etc' };
        expect(UpdateProjectSchema.parse(body)).toEqual({ skillsLibrary: 'folder' });
        expect(CreateProjectSchema.parse({ slug: 'ab', name: 'x', ...body })).not.toHaveProperty('skillsLibraryPath');
    });
});

describe('Project budget settings', () => {
    it('defaults to no limits and 80%', async () => {
        expect(await service.getById(p1.id)).toMatchObject({ dailyBudgetUsd: null, weeklyBudgetUsd: null, budgetSoftPct: 80 });
    });

    it('persists, raises, clears (null) and preserves (omitted) the limits', async () => {
        expect(await service.update(p1.id, { dailyBudgetUsd: 12.5, weeklyBudgetUsd: 0, budgetSoftPct: 50 })).toMatchObject({ dailyBudgetUsd: 12.5, weeklyBudgetUsd: 0, budgetSoftPct: 50 });
        expect(await service.update(p1.id, { name: 'Renamed' })).toMatchObject({ dailyBudgetUsd: 12.5, weeklyBudgetUsd: 0, budgetSoftPct: 50 });
        expect(await service.update(p1.id, { dailyBudgetUsd: 20 })).toMatchObject({ dailyBudgetUsd: 20, weeklyBudgetUsd: 0 });
        expect(await service.update(p1.id, { dailyBudgetUsd: null, weeklyBudgetUsd: null })).toMatchObject({ dailyBudgetUsd: null, weeklyBudgetUsd: null, budgetSoftPct: 50 });
        expect((await service.list()).find((p) => p.id === p1.id)).toMatchObject({ dailyBudgetUsd: null, budgetSoftPct: 50 });
    });

    it('creates with limits', async () => {
        expect(await service.create({ slug: 'p3', name: 'P3', dailyBudgetUsd: 5 })).toMatchObject({ dailyBudgetUsd: 5, weeklyBudgetUsd: null, budgetSoftPct: 80 });
    });

    it('validates limits and the percentage', () => {
        for (const bad of [{ dailyBudgetUsd: -1 }, { weeklyBudgetUsd: Number.NaN }, { dailyBudgetUsd: Number.POSITIVE_INFINITY }, { dailyBudgetUsd: '5' }, { budgetSoftPct: 0 }, { budgetSoftPct: 100.1 }, { budgetSoftPct: null }, { budgetSoftPct: -5 }]) {
            expect(UpdateProjectSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
        }
        for (const good of [{ dailyBudgetUsd: 0 }, { weeklyBudgetUsd: null }, { budgetSoftPct: 100 }, { budgetSoftPct: 0.5 }, {}]) {
            expect(UpdateProjectSchema.safeParse(good).success, JSON.stringify(good)).toBe(true);
        }
        expect(CreateProjectSchema.safeParse({ slug: 'ok-1', name: 'n', dailyBudgetUsd: -0.01 }).success).toBe(false);
        expect(UpdateProjectSchema.parse({})).toEqual({});
    });
});
