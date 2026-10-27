import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Wake bookkeeping of one project for one UTC day (`day` is `YYYY-MM-DD`): the wakes claimed so far (immediate wakes and the
 * summary together), whether the day's summary was claimed, and the last actual wake. Claims are conditional updates, so
 * concurrent callers and restarts cannot exceed the daily cap.
 */
@Entity({ name: 'scout_wake_days' })
@Index(['projectId', 'day'], { unique: true })
export class ScoutWakeDay {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ type: 'varchar', length: 10 })
    day: string;

    @Column({ name: 'wakes_used', type: 'integer', default: 0 })
    wakesUsed: number;

    @Column({ name: 'summary_claimed_at', type: Date, nullable: true })
    summaryClaimedAt: Date | null;

    @Column({ name: 'last_wake_at', type: Date, nullable: true })
    lastWakeAt: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
