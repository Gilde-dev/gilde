import { Injectable } from '@nestjs/common';

import type { RunResponseDto } from './run.dto.js';
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
            status: e.status,
            sessionId: e.sessionId,
            sessionUrl: e.sessionUrl,
            instructionsVersion: e.instructionsVersion,
            error: e.error,
            ciConclusion: e.ciConclusion,
            result: e.result,
            retro: e.retro,
            firedAt: e.firedAt?.toISOString() ?? null,
            finishedAt: e.finishedAt?.toISOString() ?? null,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }

}
