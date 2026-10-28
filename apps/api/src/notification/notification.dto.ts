import { z } from 'zod';

import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES } from './notification.entity.js';

export const MAX_NOTIFICATION_BATCH = 100;
/** Batch size when `limit` is omitted; applied by NotificationService.listDue. */
export const DEFAULT_NOTIFICATION_BATCH = 20;
export const DEFAULT_RETRY_DELAY_SECONDS = 60;
export const MAX_RETRY_DELAY_SECONDS = 24 * 60 * 60;
export const MAX_ERROR_LENGTH = 500;

const PrSchema = z.object({ repo: z.string(), number: z.number().int(), url: z.string() });

const BudgetSchema = z.object({
    scope: z.enum(['global', 'project']),
    period: z.enum(['day', 'week']),
    state: z.enum(['soft', 'hard']),
    spent: z.number(),
    limit: z.number().nullable(),
    percent: z.number().nullable(),
    startsAt: z.string(),
    resetsAt: z.string(),
    unpricedRows: z.number().int(),
    reasonKind: z.enum(['limit', 'configError']),
    variable: z.string().nullable(),
});

/** What a producer records. The occurrence key must come from stable source identity, never the clock or a row id. */
export const RecordNotificationSchema = z.object({
    occurrenceKey: z.string().min(1).max(500),
    kind: z.enum(NOTIFICATION_KINDS),
    occurredAt: z.date().optional(),
    projectId: z.string().nullable().optional(),
    jobId: z.string().nullable().optional(),
    featureId: z.string().nullable().optional(),
    title: z.string(),
    repos: z.array(z.string()),
    reason: z.string(),
    prLinks: z.array(PrSchema).optional(),
    budget: BudgetSchema.nullable().optional(),
});

/** `kinds` is a comma-separated list of kinds; omitted means all kinds. */
export const ListNotificationsQuerySchema = z.object({
    kinds: z.string().optional().transform((v) => (v ? v.split(',').map((k) => k.trim()).filter(Boolean) : undefined))
        .pipe(z.array(z.enum(NOTIFICATION_KINDS)).optional()),
    limit: z.coerce.number().int().min(1).max(MAX_NOTIFICATION_BATCH).optional(),
});

export const FailNotificationSchema = z.object({
    reason: z.string().min(1),
    /** False for permanent failures: the row stays failed without an automatic retry. */
    retryable: z.boolean().optional(),
    /** Delay before the next attempt; defaults to 60 seconds. */
    retryAfterSeconds: z.number().int().min(1).max(MAX_RETRY_DELAY_SECONDS).optional(),
});

export const NotificationResponseSchema = z.object({
    id: z.string().uuid(),
    occurrenceKey: z.string(),
    kind: z.enum(NOTIFICATION_KINDS),
    occurredAt: z.string().datetime(),
    projectId: z.string().nullable(),
    jobId: z.string().nullable(),
    featureId: z.string().nullable(),
    title: z.string(),
    repos: z.array(z.string()),
    reason: z.string(),
    prLinks: z.array(PrSchema),
    budget: BudgetSchema.nullable(),
    status: z.enum(NOTIFICATION_STATUSES),
    attempts: z.number().int(),
    nextRetryAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
    deliveredAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
});

export type RecordNotificationInput = z.input<typeof RecordNotificationSchema>;
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;
export type FailNotificationDto = z.infer<typeof FailNotificationSchema>;
export type NotificationResponseDto = z.infer<typeof NotificationResponseSchema>;
