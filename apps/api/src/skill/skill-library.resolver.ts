import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { GITHUB_PORT, type GitHubPort } from '../github/github.port.js';
import type { ProjectResponseDto } from '../project/project.dto.js';
import { RepoService } from '../repo/repo.service.js';

import { FolderSkillLibrary } from './folder-skill-library.js';
import { RepoSkillLibrary } from './repo-skill-library.js';
import { REGISTRY_FILE, type SkillLibrary } from './skill-library.js';

export interface ResolvedLibrary {
    kind: 'folder' | 'repo';
    /** For a repo library, the repo it is read from. */
    repoFullName: string | null;
    library: SkillLibrary;
}

/** Picks the library a project is configured for. Instances are kept so their caches survive between requests. */
@Injectable()
export class SkillLibraryResolver {
    private readonly folders = new Map<string, FolderSkillLibrary>();
    private readonly repos = new Map<string, RepoSkillLibrary>();

    constructor(
        private readonly repoService: RepoService,
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
    ) { }

    async resolve(project: Pick<ProjectResponseDto, 'id' | 'skillsLibrary' | 'skillsLibraryRepoId'>): Promise<ResolvedLibrary> {
        switch (project.skillsLibrary) {
            case 'folder':
                return this.folder();
            case 'repo':
                return this.repo(project);
            default:
                throw new ServiceUnavailableException('This project has no skills library configured');
        }
    }

    private async folder(): Promise<ResolvedLibrary> {
        const path = process.env.SKILLS_LIBRARY_PATH;
        if (!path) throw new ServiceUnavailableException('SKILLS_LIBRARY_PATH is not set on the server');
        try {
            await access(join(path, REGISTRY_FILE));
        } catch {
            throw new ServiceUnavailableException(`SKILLS_LIBRARY_PATH has no ${REGISTRY_FILE}`);
        }
        let library = this.folders.get(path);
        if (!library) this.folders.set(path, (library = new FolderSkillLibrary(path)));
        return { kind: 'folder', repoFullName: null, library };
    }

    private async repo(project: Pick<ProjectResponseDto, 'id' | 'skillsLibraryRepoId'>): Promise<ResolvedLibrary> {
        const missing = new ServiceUnavailableException('The skills library repo is not registered in this project');
        if (!project.skillsLibraryRepoId) throw missing;
        const repo = await this.repoService.getById(project.skillsLibraryRepoId).catch((e: unknown) => {
            throw e instanceof NotFoundException ? missing : e;
        });
        if (repo.projectId !== project.id) throw missing;
        const key = `${repo.id}:${repo.fullName}:${repo.defaultBranch}`;
        let library = this.repos.get(key);
        if (!library) this.repos.set(key, (library = new RepoSkillLibrary(this.github, repo)));
        return { kind: 'repo', repoFullName: repo.fullName, library };
    }
}
