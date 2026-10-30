import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';
import {
    DEFAULT_RETRY_DELAY_SECONDS,
    MAX_ERROR_LENGTH,
    type DeliveriesQuery,
    type DeliveryPageDto,
    type FailNotificationDto,
    DEFAULT_NOTIFICATION_BATCH,
    type ListNotificationsQuery,
    type NotificationResponseDto,
    type RecordNotificationInput,
} from './notification.dto.js';
import { Notification } from './notification.entity.js';
import { NotificationMapper } from './notification.mapper.js';

/** Envelope, or a function that gathers it (null: nothing to record); a throwing function is logged like a failed insert. */
export type NotificationSource = RecordNotificationInput | (() => RecordNotificationInput | null | Promise<RecordNotificationInput | null>);

/** Redacts bearer tokens and token-like values, collapses whitespace and bounds the length. */
export function sanitizeReason(reason: string): string {
    return reason
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:xox[a-z]-|xapp-|gk_|ghp_|github_pat_|sk-)[\w-]+/gi, '[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ERROR_LENGTH);
}

@Injectable()
export class NotificationService {

    private readonly logger = new Logger(NotificationService.name);

    constructor(
        @InjectRepository(Notification) private readonly notifications: Repository<Notification>,
        private readonly mapper: NotificationMapper,
    ) { }

    /**
     * Best-effort capture for callers that already wrote their domain change: one insert, never throws.
     * Returns true when a new row was recorded; false for an already recorded occurrence or a logged failure.
     */
    async recordQuietly(source: NotificationSource): Promise<boolean> {
        let input: RecordNotificationInput | undefined;
        try {
            const gathered = typeof source === 'function' ? await source() : source;
            if (!gathered) return false;
            input = gathered;
            await this.notifications.insert({
                occurrenceKey: input.occurrenceKey,
                kind: input.kind,
                occurredAt: input.occurredAt ?? new Date(),
                projectId: input.projectId ?? null,
                jobId: input.jobId ?? null,
                featureId: input.featureId ?? null,
                title: input.title.slice(0, 500),
                repos: input.repos,
                reason: input.reason,
                prLinks: input.prLinks ?? [],
                budget: input.budget ?? null,
            });
            return true;
        } catch (e) {
            if (input && isUniqueViolation(e)) return false;
            const key = input ? ` ${input.occurrenceKey}` : '';
            this.logger.error(`Failed to record notification${key}: ${sanitizeReason(e instanceof Error ? e.message : String(e))}`);
            return false;
        }
    }

    /** Delivered and failed rows, newest first: what the Slack bot has done. Pending rows are not activity yet. */
    async deliveries(q: DeliveriesQuery): Promise<DeliveryPageDto> {
        const page = q.page ?? 1;
        const pageSize = q.pageSize ?? 25;
        const [rows, total] = await this.notifications.createQueryBuilder('n')
            .where('n.status IN (:...statuses)', { statuses: ['delivered', 'failed'] })
            .orderBy('n.createdAt', 'DESC').addOrderBy('n.id', 'DESC')
            .skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
        return {
            items: rows.map((n) => ({
                id: n.id, kind: n.kind, title: n.title, projectId: n.projectId, jobId: n.jobId, status: n.status, attempts: n.attempts,
                lastError: n.lastError === null ? null : sanitizeReason(n.lastError), occurredAt: n.occurredAt.toISOString(), deliveredAt: n.deliveredAt?.toISOString() ?? null,
            })),
            page, pageSize, total,
        };
    }

    /** Pending rows and failed rows whose retry is due, oldest first. */
    async listDue(q: ListNotificationsQuery, now = new Date()): Promise<NotificationResponseDto[]> {
        const qb = this.notifications.createQueryBuilder('n')
            .where(new Brackets((w) => w
                .where('n.status = :pending', { pending: 'pending' })
                .orWhere('(n.status = :failed AND n.nextRetryAt IS NOT NULL AND n.nextRetryAt <= :now)', { failed: 'failed', now })))
            .orderBy('n.createdAt', 'ASC')
            .addOrderBy('n.id', 'ASC')
            .limit(q.limit ?? DEFAULT_NOTIFICATION_BATCH);
        if (q.kinds) qb.andWhere('n.kind IN (:...kinds)', { kinds: q.kinds });
        return (await qb.getMany()).map((n) => this.mapper.toDTO(n));
    }

    /** Idempotent and terminal. */
    async markDelivered(id: string): Promise<NotificationResponseDto> {
        await this.notifications.createQueryBuilder()
            .update(Notification)
            .set({ status: 'delivered', deliveredAt: new Date(), nextRetryAt: null })
            .where('id = :id AND status != :delivered', { id, delivered: 'delivered' })
            .execute();
        return this.get(id);
    }

    /** Counts the attempt and stores the retry time; a delivered row is returned unchanged. */
    async markFailed(id: string, dto: FailNotificationDto, now = new Date()): Promise<NotificationResponseDto> {
        const retryable = dto.retryable ?? true;
        const delay = dto.retryAfterSeconds ?? DEFAULT_RETRY_DELAY_SECONDS;
        await this.notifications.createQueryBuilder()
            .update(Notification)
            .set({
                status: 'failed',
                attempts: () => 'attempts + 1',
                nextRetryAt: retryable ? new Date(now.getTime() + delay * 1000) : null,
                lastError: sanitizeReason(dto.reason),
            })
            .where('id = :id AND status != :delivered', { id, delivered: 'delivered' })
            .execute();
        return this.get(id);
    }

    private async get(id: string): Promise<NotificationResponseDto> {
        const row = await this.notifications.findOneBy({ id });
        if (!row) throw new NotFoundException(`Notification ${id} not found`);
        return this.mapper.toDTO(row);
    }

}
