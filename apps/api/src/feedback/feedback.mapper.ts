import { Injectable } from '@nestjs/common';

import type { FeedbackResponseDto } from './feedback.dto.js';
import { Feedback } from './feedback.entity.js';

@Injectable()
export class FeedbackMapper {

    toDTO(e: Feedback): FeedbackResponseDto {
        return {
            id: e.id,
            jobId: e.jobId,
            projectId: e.projectId,
            repoId: e.repoId,
            prNumber: e.prNumber,
            kind: e.kind,
            githubId: e.githubId,
            author: e.author,
            authorAssociation: e.authorAssociation,
            state: e.state,
            reviewId: e.reviewId,
            path: e.path,
            line: e.line,
            body: e.body,
            url: e.url,
            createdAt: e.createdAt.toISOString(),
        };
    }

}
