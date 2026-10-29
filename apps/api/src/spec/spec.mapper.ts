import { Injectable } from '@nestjs/common';

import type { SpecApprovalEvidenceDto, SpecResponseDto, SpecSourceDto } from './spec.dto.js';
import { Spec } from './spec.entity.js';
import type { SpecPlanningRunDto } from './spec.dto.js';
import { SpecPlanningRun } from './spec-planning-run.entity.js';
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
            planNote: e.planNote ?? null,
        };
    }

    planningToDTO(r: SpecPlanningRun): SpecPlanningRunDto {
        return {
            id: r.id,
            version: r.version,
            status: r.status,
            attempts: r.attempts,
            featureId: r.featureId,
            reason: r.reason,
            trigger: r.trigger,
            requestedById: r.requestedById,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
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
