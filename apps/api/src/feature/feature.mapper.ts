import { Injectable } from '@nestjs/common';

import type { FeatureProgressDto, FeatureResponseDto } from './feature.dto.js';
import { Feature } from './feature.entity.js';

@Injectable()
export class FeatureMapper {

    toDTO(e: Feature, progress: FeatureProgressDto): FeatureResponseDto {
        return {
            id: e.id,
            projectId: e.projectId,
            title: e.title,
            spec: e.spec,
            acceptanceCriteria: e.acceptanceCriteria,
            status: e.status,
            startedAt: e.startedAt?.toISOString() ?? null,
            doneAt: e.doneAt?.toISOString() ?? null,
            progress,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }

}
