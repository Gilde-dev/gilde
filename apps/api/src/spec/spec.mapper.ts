import { Injectable } from '@nestjs/common';

import type { SpecApprovalEvidenceDto, SpecResponseDto, SpecSourceDto } from './spec.dto.js';
import { Spec } from './spec.entity.js';
import { SpecApproval } from './spec-approval.entity.js';

@Injectable()
export class SpecMapper {

    toDTO(e: Spec, source: SpecSourceDto | null = null): SpecResponseDto {
        return {
            id: e.id,
            projectId: e.projectId,
            repoId: e.repoId,
            slug: e.slug,
            title: e.title,
            status: e.status,
            currentVersion: e.currentVersion,
            approvedVersion: e.approvedVersion,
            createdById: e.createdById,
            updatedById: e.updatedById,
            approvedById: e.approvedById,
            approvedAt: e.approvedAt?.toISOString() ?? null,
            archivedAt: e.archivedAt?.toISOString() ?? null,
            archivedById: e.archivedById,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
            source,
        };
    }

    approvalToDTO(a: SpecApproval): SpecApprovalEvidenceDto {
        return {
            id: a.id,
            approvedById: a.approvedById,
            approvedByName: a.approvedByName,
            approvedByEmail: a.approvedByEmail,
            approvedAt: a.approvedAt.toISOString(),
        };
    }
}
