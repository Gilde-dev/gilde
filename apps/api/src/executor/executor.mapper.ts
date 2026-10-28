import { Injectable } from '@nestjs/common';

import type { ExecutorResponseDto } from './executor.dto.js';
import { Executor } from './executor.entity.js';

@Injectable()
export class ExecutorMapper {

    toDTO(entity: Executor): ExecutorResponseDto {
        return {
            id: entity.id,
            ownerId: entity.ownerId,
            name: entity.name,
            kind: entity.kind,
            fireUrl: entity.fireUrl,
            hasToken: entity.tokenLast4 !== null,
            tokenLast4: entity.tokenLast4,
            repoIds: entity.repoIds,
            maxConcurrent: entity.maxConcurrent,
            dailyRunLimit: entity.dailyRunLimit,
            enabled: entity.enabled,
            exhaustedUntil: entity.exhaustedUntil?.toISOString() ?? null,
            createdAt: entity.createdAt.toISOString(),
            updatedAt: entity.updatedAt.toISOString(),
        };
    }
}
