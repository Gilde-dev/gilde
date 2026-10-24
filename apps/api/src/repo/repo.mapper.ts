import { Injectable } from '@nestjs/common';

import type { RepoResponseDto } from './repo.dto.js';
import { Repo } from './repo.entity.js';

@Injectable()
export class RepoMapper {
    toDTO(entity: Repo): RepoResponseDto {
        return {
            id: entity.id,
            projectId: entity.projectId,
            fullName: entity.fullName,
            defaultBranch: entity.defaultBranch,
            stack: entity.stack,
            testCommand: entity.testCommand,
            routineFireUrl: entity.routineFireUrl,
            routineTokenEnv: entity.routineTokenEnv,
            maxConcurrentJobs: entity.maxConcurrentJobs,
            paused: entity.paused,
            createdAt: entity.createdAt.toISOString(),
            updatedAt: entity.updatedAt.toISOString(),
        };
    }
}