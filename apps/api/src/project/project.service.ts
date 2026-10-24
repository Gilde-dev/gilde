import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import { InjectRepository } from "@nestjs/typeorm";
import { QueryFailedError, Repository } from "typeorm";

import { ProjectMapper } from "./project.mapper.js";
import { CreateProjectDto, ProjectResponseDto, UpdateProjectDto } from "./project.dto.js";
import { Project } from "./project.entity.js";

@Injectable()
export class ProjectService {

    constructor(
        private readonly projectMapper: ProjectMapper,
        @InjectRepository(Project) private projectRepository: Repository<Project>
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
            const entity = await this.projectRepository.save(this.projectRepository.create(dto));
            return this.projectMapper.toDTO(entity);
        } catch (e) {
            // Two requests with the same slug at the same moment: the unique index decides.
            if (isUniqueViolation(e)) throw new ConflictException(`A project with slug '${dto.slug}' already exists`);
            throw e;
        }
    }

    async update(id: string, dto: UpdateProjectDto): Promise<ProjectResponseDto> {
        const entity = await this.getOrFail(id);
        const saved = await this.projectRepository.save(this.projectRepository.merge(entity, dto));
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