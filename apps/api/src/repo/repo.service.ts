// repo.service.ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';

import { ProjectService } from '../project/project.service.js';
import type { CreateRepoDto, RepoResponseDto, UpdateRepoDto } from './repo.dto.js';
import { Repo } from './repo.entity.js';
import { RepoMapper } from './repo.mapper.js';

@Injectable()
export class RepoService {
    constructor(
        private readonly repoMapper: RepoMapper,
        private readonly projectService: ProjectService,
        @InjectRepository(Repo) private readonly repoRepository: Repository<Repo>,
    ) { }

    async listForProject(projectId: string): Promise<RepoResponseDto[]> {
        await this.projectService.assertExists(projectId);
        const entities = await this.repoRepository.find({ where: { projectId }, order: { fullName: 'ASC' } });
        return entities.map((e) => this.repoMapper.toDTO(e));
    }

    async getById(id: string): Promise<RepoResponseDto> {
        return this.repoMapper.toDTO(await this.getOrFail(id));
    }

    async create(projectId: string, dto: CreateRepoDto): Promise<RepoResponseDto> {
        await this.projectService.assertExists(projectId);
        if (await this.repoRepository.existsBy({ fullName: dto.fullName })) {
            throw new ConflictException(`Repository ${dto.fullName} is already registered`);
        }
        try {
            const entity = await this.repoRepository.save(this.repoRepository.create({ ...dto, projectId }));
            return this.repoMapper.toDTO(entity);
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`Repository ${dto.fullName} is already registered`);
            throw e;
        }
    }

    async update(id: string, dto: UpdateRepoDto): Promise<RepoResponseDto> {
        const entity = await this.getOrFail(id);
        const saved = await this.repoRepository.save(this.repoRepository.merge(entity, dto));
        return this.repoMapper.toDTO(saved);
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
        return this.repoMapper.toDTO(await this.repoRepository.save(entity));
    }

    private async getOrFail(id: string): Promise<Repo> {
        const entity = await this.repoRepository.findOneBy({ id });
        if (!entity) throw new NotFoundException(`Repo ${id} not found`);
        return entity;
    }
}