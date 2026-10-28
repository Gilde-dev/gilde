import { Injectable } from '@nestjs/common';

import type { RepoResponseDto } from './repo.dto.js';
import type { AppStatus } from './github-installation.service.js';
import { Repo } from './repo.entity.js';

@Injectable()
export class RepoMapper {
    toDTO(entity: Repo, app?: AppStatus): RepoResponseDto {
        return {
            id: entity.id,
            projectId: entity.projectId,
            fullName: entity.fullName,
            defaultBranch: entity.defaultBranch,
            routineFireUrl: entity.routineFireUrl,
            routineTokenEnv: entity.routineTokenEnv,
            maxConcurrentJobs: entity.maxConcurrentJobs,
            stacks: entity.stacks ?? [],
            testCommands: entity.testCommands ?? [],
            skills: entity.skills ?? null,
            manifestSha: entity.manifestSha ?? null,
            manifestSyncedAt: entity.manifestSyncedAt?.toISOString() ?? null,
            manifestError: entity.manifestError ?? null,
            githubAppInstalled: app?.installed ?? null,
            githubAppWarning: app?.warning ?? null,
            paused: entity.paused,
            pausedReason: entity.pausedReason ?? null,
            createdAt: entity.createdAt.toISOString(),
            updatedAt: entity.updatedAt.toISOString(),
        };
    }
}