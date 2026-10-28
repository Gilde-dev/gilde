// repo.service.ts
import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';

import { ProjectService } from '../project/project.service.js';
import type { CreateRepoDto, RepoResponseDto, ReplaceRepoDto } from './repo.dto.js';
import { Repo } from './repo.entity.js';
import { RepoMapper } from './repo.mapper.js';
import { GithubInstallationService } from './github-installation.service.js';
import { RepoManifestService } from './repo-manifest.service.js';

@Injectable()
export class RepoService {
    constructor(
        private readonly repoMapper: RepoMapper,
        private readonly projectService: ProjectService,
        @InjectRepository(Repo) private readonly repoRepository: Repository<Repo>,
        @Optional() private readonly manifests?: RepoManifestService,
        @Optional() private readonly installations?: GithubInstallationService,
    ) { }

    async listForProject(projectId: string): Promise<RepoResponseDto[]> {
        await this.projectService.assertExists(projectId);
        const entities = await this.repoRepository.find({ where: { projectId }, order: { fullName: 'ASC' } });
        const status = await this.installations?.statusFor(entities.map((e) => e.fullName));
        return entities.map((e) => this.repoMapper.toDTO(e, status?.get(e.fullName)));
    }

    async getById(id: string): Promise<RepoResponseDto> {
        return this.withStatus(await this.getOrFail(id));
    }

    private async withStatus(entity: Repo): Promise<RepoResponseDto> {
        const status = await this.installations?.statusFor([entity.fullName]);
        return this.repoMapper.toDTO(entity, status?.get(entity.fullName));
    }

    async create(projectId: string, dto: CreateRepoDto): Promise<RepoResponseDto> {
        await this.projectService.assertExists(projectId);
        if (await this.repoRepository.existsBy({ fullName: dto.fullName })) {
            throw new ConflictException(`Repository ${dto.fullName} is already registered`);
        }
        try {
            const entity = await this.repoRepository.save(this.repoRepository.create({ ...dto, projectId }));
            return (await this.manifests?.refresh(entity.id)) ?? await this.withStatus(entity);
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`Repository ${dto.fullName} is already registered`);
            throw e;
        }
    }

    /** Replaces the updatable settings; fullName and the manifest fields are not part of it. */
    async update(id: string, dto: ReplaceRepoDto): Promise<RepoResponseDto> {
        const entity = await this.getOrFail(id);
        // The repo-level routine settings are no longer used for firing; a PUT never changes them.
        const { routineFireUrl: _fireUrl, routineTokenEnv: _tokenEnv, ...settings } = dto;
        const saved = await this.repoRepository.save(this.repoRepository.merge(entity, settings));
        return this.withStatus(saved);
    }

    pause(id: string): Promise<RepoResponseDto> {
        return this.setPaused(id, true);
    }

    resume(id: string): Promise<RepoResponseDto> {
        return this.setPaused(id, false);
    }

    /** Pauses a repo and records why (e.g. a configuration error found by the dispatcher). */
    pauseWithReason(id: string, reason: string): Promise<RepoResponseDto> {
        return this.setPaused(id, true, reason);
    }

    /** The given ids that are not a registered repository. */
    async findMissingIds(ids: string[]): Promise<string[]> {
        if (!ids.length) return [];
        const found = new Set((await this.repoRepository.find({ select: { id: true }, where: { id: In(ids) } })).map((r) => r.id));
        return ids.filter((id) => !found.has(id));
    }

    findByFullName(fullName: string): Promise<Repo | null> {
        return this.repoRepository.findOne({
            where: { fullName: fullName.toLowerCase() },
            relations: { project: true },
        });
    }

    private async setPaused(id: string, paused: boolean, reason: string | null = null): Promise<RepoResponseDto> {
        const entity = await this.getOrFail(id);
        entity.paused = paused;
        entity.pausedReason = paused ? reason : null;
        return this.withStatus(await this.repoRepository.save(entity));
    }

    private async getOrFail(id: string): Promise<Repo> {
        const entity = await this.repoRepository.findOneBy({ id });
        if (!entity) throw new NotFoundException(`Repo ${id} not found`);
        return entity;
    }
}