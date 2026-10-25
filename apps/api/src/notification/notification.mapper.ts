import { Injectable } from '@nestjs/common';

import type { NotificationResponseDto } from './notification.dto.js';
import { Notification } from './notification.entity.js';

@Injectable()
export class NotificationMapper {

    toDTO(e: Notification): NotificationResponseDto {
        return {
            id: e.id,
            occurrenceKey: e.occurrenceKey,
            kind: e.kind,
            occurredAt: e.occurredAt.toISOString(),
            projectId: e.projectId,
            jobId: e.jobId,
            featureId: e.featureId,
            title: e.title,
            repos: e.repos,
            reason: e.reason,
            prLinks: e.prLinks,
            status: e.status,
            attempts: e.attempts,
            nextRetryAt: e.nextRetryAt?.toISOString() ?? null,
            lastError: e.lastError,
            deliveredAt: e.deliveredAt?.toISOString() ?? null,
            createdAt: e.createdAt.toISOString(),
        };
    }

}
