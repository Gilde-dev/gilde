import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import { InjectRepository } from "@nestjs/typeorm";
import { QueryFailedError, Repository } from "typeorm";

import { ProjectMapper } from "./project.mapper.js";
import { CreateProjectDto, ProjectResponseDto, UpdateProjectDto } from "./project.dto.js";
import { Project } from "./project.entity.js";
import { Repo } from "../repo/repo.entity.js";

@Injectable()
export class ProjectService {

    constructor(
        private readonly projectMapper: ProjectMapper,
        @InjectRepository(Project) private projectRepository: Repository<Project>,
        @InjectRepository(Repo) private repoRepository: Repository<Repo>
    ) { }

    async list(): Promise<ProjectResponseDto[]> {
        const entities = await this.projectRepository.find({ order: { name: 'ASC' } });
        return entities.map((e) => this.projectMapper.toDTO(e));
    }

    async getById(id: string): Promise<ProjectResponseDto> {
        const entity = await this.getOrFail(id);

        return this.projectMapper.toDTO(entity);
    }

    async getBySlug(slug: string): Promise<ProjectResponseDto> {
        const entity = await this.projectRepository.findOneBy({ slug });
        if (!entity) throw new NotFoundException(`Project '${slug}' not found`);
        return this.projectMapper.toDTO(entity);
    }

    async create(dto: CreateProjectDto): Promise<ProjectResponseDto> {
        if (await this.projectRepository.existsBy({ slug: dto.slug })) {
            throw new ConflictException(`A project with slug '${dto.slug}' already exists`);
        }
        try {
            const entity = this.projectRepository.create(dto);
            await this.applySkillsLibrary(entity, dto);
            await this.projectRepository.save(entity);
            return this.projectMapper.toDTO(entity);
        } catch (e) {
            // Two requests with the same slug at the same moment: the unique index decides.
            if (isUniqueViolation(e)) throw new ConflictException(`A project with slug '${dto.slug}' already exists`);
            throw e;
        }
    }

    async update(id: string, dto: UpdateProjectDto): Promise<ProjectResponseDto> {
        const entity = await this.getOrFail(id);
        this.projectRepository.merge(entity, dto);
        await this.applySkillsLibrary(entity, dto);
        const saved = await this.projectRepository.save(entity);
        return this.projectMapper.toDTO(saved);
    }

    pause(id: string): Promise<ProjectResponseDto> {
        return this.setPaused(id, true);
    }

    resume(id: string): Promise<ProjectResponseDto> {
        return this.setPaused(id, false);
    }

    async assertExists(id: string): Promise<void> {
        if (!(await this.projectRepository.existsBy({ id }))) {
            throw new NotFoundException(`Project ${id} not found`);
        }
    }

    /** A repo library must point at a repo of this project; any other kind has no repo. */
    private async applySkillsLibrary(entity: Project, dto: UpdateProjectDto): Promise<void> {
        entity.skillsLibrary ??= 'none';
        if (entity.skillsLibrary !== 'repo') {
            entity.skillsLibraryRepoId = null;
            return;
        }
        const repoId = entity.skillsLibraryRepoId;
        if (!repoId) throw new BadRequestException("skillsLibraryRepoId is required when skillsLibrary is 'repo'");
        // Only (re)check when the config changes; a repo removed later is reported by the resolver.
        if (dto.skillsLibrary === undefined && dto.skillsLibraryRepoId === undefined) return;
        if (!entity.id || !(await this.repoRepository.existsBy({ id: repoId, projectId: entity.id }))) {
            throw new BadRequestException('skillsLibraryRepoId must be a repo in the same project');
        }
    }

    private async setPaused(id: string, paused: boolean): Promise<ProjectResponseDto> {
        const entity = await this.getOrFail(id);
        entity.paused = paused;
        return this.projectMapper.toDTO(await this.projectRepository.save(entity));
    }

    private async getOrFail(id: string): Promise<Project> {
        const entity = await this.projectRepository.findOneBy({ id });
        if (!entity) throw new NotFoundException(`Project ${id} not found`);
        return entity;
    }
}

function isUniqueViolation(e: unknown): boolean {
    if (!(e instanceof QueryFailedError)) return false;
    const code = (e.driverError as { code?: string } | undefined)?.code;
    return code === '23505' /* postgres */ || code === 'SQLITE_CONSTRAINT_UNIQUE' /* better-sqlite3 */;
}