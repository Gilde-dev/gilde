import { Injectable } from '@nestjs/common';

import type { IntakeItem } from './intake-item.entity.js';
import type { IntakeItemDetailResponseDto, IntakeItemResponseDto } from './intake.dto.js';

@Injectable()
export class IntakeMapper {

    toDTO(item: IntakeItem): IntakeItemResponseDto {
        return {
            id: item.id,
            projectId: item.projectId,
            repoId: item.repoId,
            repoFullName: item.repo?.fullName ?? null,
            source: item.source,
            externalId: item.externalId,
            number: item.number,
            url: item.url,
            title: item.title,
            authorLogin: item.authorLogin,
            labels: item.labels,
            status: item.status,
            specId: item.specId,
            lastError: item.lastError,
            refineAttempts: item.refineAttempts,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
        };
    }

    toDetailDTO(item: IntakeItem): IntakeItemDetailResponseDto {
        return {
            ...this.toDTO(item),
            body: item.body,
            bodyTruncated: item.bodyTruncated,
            bodySha256: item.bodySha256,
            refinedSha256: item.refinedSha256,
        };
    }
}
