import { Injectable } from '@nestjs/common';

import type { BlockingJobDto, JobResponseDto } from './job.dto.js';
import { Job } from './job.entity.js';

const FAILED_DEPENDENCY: readonly string[] = ['rejected', 'parked', 'cancelled'];

const isOpenPr = (e: Job) => e.prNumber !== null && (e.status === 'pr_open' || e.status === 'awaiting_review' || e.status === 'queued' || e.status === 'dispatched' || e.status === 'parked');

@Injectable()
export class JobMapper {

    toDTO(e: Job, deps: { dependsOn: string[]; blockedBy: BlockingJobDto[]; pendingRevisions?: number; revision?: number; replacedById?: string | null; createdBy?: { id: string; name: string } | null; ownerId?: string | null } = { dependsOn: [], blockedBy: [] }): JobResponseDto {
        return {
            id: e.id,
            projectId: e.projectId,
            repoId: e.repoId,
            featureId: e.featureId,
            title: e.title,
            task: e.task,
            acceptanceCriteria: e.acceptanceCriteria,
            status: e.status,
            attempts: e.attempts,
            queuedAt: e.queuedAt?.toISOString() ?? null,
            prNumber: e.prNumber,
            prUrl: e.prUrl,
            branch: e.branch,
            lastReason: e.lastReason,
            needsApproval: e.needsApproval,
            approvalReason: e.approvalReason,
            dependsOn: deps.dependsOn,
            blockedBy: deps.blockedBy,
            pendingRevisions: deps.pendingRevisions ?? 0,
            revision: deps.revision ?? 0,
            ...(deps.blockedBy.some((b) => FAILED_DEPENDENCY.includes(b.status) || b.mergedBlocked) ? { failedDependency: true } : {}),
            mergeConflict: isOpenPr(e) && e.mergeConflict,
            mergeConflictCheckedAt: e.mergeConflictCheckedAt?.toISOString() ?? null,
            mergedBlocked: e.status === 'merged' && e.mergedBlocked,
            replacedById: deps.replacedById ?? null,
            recreatedFromId: e.recreatedFromId ?? null,
            createdBy: deps.createdBy ?? null,
            ownerId: deps.ownerId ?? null,
            waitingReason: e.status === 'queued' ? e.waitingReason : null,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }

}