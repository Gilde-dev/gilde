import { Injectable } from '@nestjs/common';

import type { JobResponseDto } from './job.dto.js';
import { Job } from './job.entity.js';

@Injectable()
export class JobMapper {

    toDTO(e: Job): JobResponseDto {
        return {
            id: e.id,
            projectId: e.projectId,
            repoId: e.repoId,
            title: e.title,
            task: e.task,
            acceptanceCriteria: e.acceptanceCriteria,
            status: e.status,
            attempts: e.attempts,
            queuedAt: e.queuedAt.toISOString(),
            prNumber: e.prNumber,
            prUrl: e.prUrl,
            branch: e.branch,
            lastReason: e.lastReason,
            needsApproval: e.needsApproval,
            approvalReason: e.approvalReason,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }

}