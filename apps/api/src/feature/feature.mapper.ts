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
            pinnedSpec: e.specPin
                ? {
                    specId: e.specPin.specId,
                    specVersionId: e.specPin.specVersionId,
                    version: e.specPin.version,
                    slug: e.specPin.slug,
                    title: e.specPin.title,
                    repoId: e.specPin.repoId,
                    repoFullName: e.specPin.repoFullName,
                    path: e.specPin.path,
                    bodySha256: e.specPin.bodySha256,
                    approvalId: e.specPin.approvalId,
                    approvedAt: e.specPin.approvedAt,
                    approvedByName: e.specPin.approvedByName,
                    recordingId: e.specPin.recordingId,
                    recordingJobId: e.specPin.recordingJobId,
                    recordingJobTitle: e.specPin.recordingJobTitle,
                }
                : null,
            status: e.status,
            startedAt: e.startedAt?.toISOString() ?? null,
            doneAt: e.doneAt?.toISOString() ?? null,
            progress,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }

}
