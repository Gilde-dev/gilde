import { Injectable } from '@nestjs/common';

import type { RunResponseDto } from './run.dto.js';
import { toOperatorActionDtos } from './operator-actions.js';
import { JobRun } from './run.entity.js';

@Injectable()
export class RunMapper {

    toDTO(e: JobRun): RunResponseDto {
        return {
            id: e.id,
            jobId: e.jobId,
            projectId: e.projectId,
            repoId: e.repoId,
            attempt: e.attempt,
            kind: e.kind ?? 'attempt',
            executorId: e.executorId,
            status: e.status,
            sessionId: e.sessionId,
            sessionUrl: e.sessionUrl,
            instructionsVersion: e.instructionsVersion,
            context: e.context ?? null,
            contextError: e.contextError ?? null,
            knowledge: e.knowledge ?? [],
            error: e.error,
            ciConclusion: e.ciConclusion,
            result: e.result,
            operatorActions: toOperatorActionDtos(e.operatorActions),
            retro: e.retro,
            firedAt: e.firedAt?.toISOString() ?? null,
            finishedAt: e.finishedAt?.toISOString() ?? null,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }

}
