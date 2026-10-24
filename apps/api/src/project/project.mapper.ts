import { Injectable } from "@nestjs/common";
import { Project } from "./project.entity.js";
import { ProjectResponseDto } from "./project.dto.js";

@Injectable()
export class ProjectMapper {

    toDTO(entity: Project): ProjectResponseDto {
        return {
            id: entity.id,
            slug: entity.slug,
            name: entity.name,
            description: entity.description,
            dailyRunLimit: entity.dailyRunLimit,
            retryOnChangesRequested: entity.retryOnChangesRequested,
            runTimeoutMinutes: entity.runTimeoutMinutes,
            paused: entity.paused,
            maxAttempts: entity.maxAttempts,
            createdAt: entity.createdAt?.toISOString() || '',
            updatedAt: entity.updatedAt?.toISOString() || ''
        }
    }
}