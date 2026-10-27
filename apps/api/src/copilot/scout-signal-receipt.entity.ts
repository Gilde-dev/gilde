import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Durable claim for one published scout event. The native inbox only coalesces a dedupeKey while the first record is
 * still pending, so this unique (project, key) pair is what keeps a redelivered or restarted event from being sent twice.
 */
@Entity({ name: 'scout_signal_receipts' })
@Index(['projectId', 'dedupeKey'], { unique: true })
export class ScoutSignalReceipt {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ name: 'dedupe_key', type: 'varchar', length: 255 })
    dedupeKey: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
