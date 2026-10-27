import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const NOTIFICATION_KINDS = [
    'job.awaiting_review',
    'job.parked',
    'job.approval_needed',
    'revision.waiting',
    'feature.ready_to_close',
    'budget.soft',
    'budget.hard',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Structured facts of a budget.soft / budget.hard event; the envelope's job, PR and repo fields stay empty for it. */
export interface NotificationBudget {
    scope: 'global' | 'project';
    period: 'day' | 'week';
    state: 'soft' | 'hard';
    /** Sum of the known estimated costs in USD. */
    spent: number;
    limit: number | null;
    percent: number | null;
    /** UTC period start (inclusive) and reset (exclusive end), ISO. */
    startsAt: string;
    resetsAt: string;
    unpricedRows: number;
    /** `configError`: an invalid global environment variable, named in `variable` (never its value). */
    reasonKind: 'limit' | 'configError';
    variable: string | null;
}

export interface NotificationPr {
    repo: string;
    number: number;
    url: string;
}

/**
 * One factory event, with the delivery state of the single consumer on the same row. The envelope is
 * platform-neutral; formatting and destinations belong to the consumer.
 */
@Entity({ name: 'notifications' })
@Index(['status', 'nextRetryAt'])
@Index(['createdAt', 'id'])
export class Notification {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Stable identity of the source occurrence; unique, so replays record at most once. */
    @Index({ unique: true })
    @Column({
        name: 'occurrence_key',
        type: 'varchar',
        length: 500
    })
    occurrenceKey: string;

    @Column({ type: 'simple-enum', enum: NOTIFICATION_KINDS })
    kind: NotificationKind;

    @Column({
        name: 'occurred_at',
        type: Date
    })
    occurredAt: Date;

    @Column({
        name: 'project_id',
        type: 'uuid',
        nullable: true
    })
    projectId: string | null;

    @Column({
        name: 'job_id',
        type: 'uuid',
        nullable: true
    })
    jobId: string | null;

    @Column({
        name: 'feature_id',
        type: 'uuid',
        nullable: true
    })
    featureId: string | null;

    @Column({ type: 'varchar', length: 500 })
    title: string;

    /** Full repo names involved. */
    @Column({ type: 'simple-json' })
    repos: string[];

    @Column({ type: 'text' })
    reason: string;

    @Column({
        name: 'pr_links',
        type: 'simple-json'
    })
    prLinks: NotificationPr[];

    /** Set for the budget kinds only. */
    @Column({ type: 'simple-json', nullable: true })
    budget: NotificationBudget | null;

    @Column({ type: 'simple-enum', enum: NOTIFICATION_STATUSES, default: 'pending' })
    status: NotificationStatus;

    @Column({ type: 'integer', default: 0 })
    attempts: number;

    /** When a failed row becomes due again; null for pending, delivered and permanently failed rows. */
    @Column({
        name: 'next_retry_at',
        type: Date,
        nullable: true
    })
    nextRetryAt: Date | null;

    @Column({
        name: 'last_error',
        type: 'text',
        nullable: true
    })
    lastError: string | null;

    @Column({
        name: 'delivered_at',
        type: Date,
        nullable: true
    })
    deliveredAt: Date | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;
}
