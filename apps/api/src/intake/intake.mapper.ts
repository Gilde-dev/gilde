import { Injectable } from '@nestjs/common';

import type { IntakeItem } from './intake-item.entity.js';
import type { IntakeItemDetailResponseDto, IntakeItemResponseDto, IntakeSpecSummaryDto } from './intake.dto.js';

@Injectable()
export class IntakeMapper {

    toDTO(item: IntakeItem, spec: IntakeSpecSummaryDto | null = null): IntakeItemResponseDto {
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
            spec,
            lastError: item.lastError,
            statusCommentUrl: item.statusCommentUrl,
            commentError: item.commentError,
            commentCount: item.comments?.length ?? 0,
            refineAttempts: item.refineAttempts,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
        };
    }

    toDetailDTO(item: IntakeItem, spec: IntakeSpecSummaryDto | null = null): IntakeItemDetailResponseDto {
        return {
            ...this.toDTO(item, spec),
            body: item.body,
            bodyTruncated: item.bodyTruncated,
            bodySha256: item.bodySha256,
            refinedSha256: item.refinedSha256,
        };
    }
}
