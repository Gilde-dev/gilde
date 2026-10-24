import { Injectable } from '@nestjs/common';

import type { BlockingJobDto, JobResponseDto } from './job.dto.js';
import { Job } from './job.entity.js';

const FAILED_DEPENDENCY: readonly string[] = ['rejected', 'parked', 'cancelled'];

@Injectable()
export class JobMapper {

    toDTO(e: Job, deps: { dependsOn: string[]; blockedBy: BlockingJobDto[] } = { dependsOn: [], blockedBy: [] }): JobResponseDto {
        return {
            id: e.id,
            projectId: e.projectId,
            repoId: e.repoId,
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
            ...(deps.blockedBy.some((b) => FAILED_DEPENDENCY.includes(b.status)) ? { failedDependency: true } : {}),
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }

}