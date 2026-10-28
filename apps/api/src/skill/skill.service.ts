import { Injectable } from '@nestjs/common';

import { ProjectService } from '../project/project.service.js';
import { RepoService } from '../repo/repo.service.js';

import { desiredSkills } from './desired-skills.js';
import { computeDrift, countStatuses, RepoSkillsReader } from './repo-skills.js';
import type { RepoSkillsResponseDto, SkillCatalogResponseDto } from './skill.dto.js';
import type { SkillImpactResponseDto } from './skill-impact.dto.js';
import { SkillImpactService } from './skill-impact.service.js';
import { SkillLibraryResolver } from './skill-library.resolver.js';

@Injectable()
export class SkillService {
    constructor(
        private readonly projects: ProjectService,
        private readonly repos: RepoService,
        private readonly resolver: SkillLibraryResolver,
        private readonly reader: RepoSkillsReader,
        private readonly impactService: SkillImpactService,
    ) { }

    impact(projectId: string, days?: number): Promise<SkillImpactResponseDto> {
        return this.impactService.impact(projectId, days);
    }

    async catalog(projectId: string): Promise<SkillCatalogResponseDto> {
        const project = await this.projects.getById(projectId);
        const { kind, repoFullName, library } = await this.resolver.resolve(project);
        const catalog = await library.getCatalog();
        const repos = await this.repos.listForProject(projectId);
        const wanted = repos.map((repo) => ({ repo, names: new Set(desiredSkills(repo, catalog)) }));
        return {
            library: { kind, repoFullName },
            skills: catalog.map((s) => ({
                name: s.name,
                description: s.description,
                scope: s.scope,
                stacks: s.stacks,
                files: s.files.map((f) => f.path),
                repos: wanted.filter((w) => w.names.has(s.name)).map((w) => ({ id: w.repo.id, fullName: w.repo.fullName })),
            })),
        };
    }

    /** Forgets cached library and repo skills, then returns the fresh catalog. */
    async refresh(projectId: string): Promise<SkillCatalogResponseDto> {
        const project = await this.projects.getById(projectId);
        const { library } = await this.resolver.resolve(project);
        library.invalidate();
        for (const repo of await this.repos.listForProject(projectId)) this.reader.invalidate(repo.id);
        return this.catalog(projectId);
    }

    async forRepo(repoId: string): Promise<RepoSkillsResponseDto> {
        const repo = await this.repos.getById(repoId);
        const project = await this.projects.getById(repo.projectId);
        const { library } = await this.resolver.resolve(project);
        const catalog = await library.getCatalog();
        const skills = computeDrift(desiredSkills(repo, catalog), catalog, await this.reader.read(repo));
        return { repoId, skills, counts: countStatuses(skills) };
    }
}
