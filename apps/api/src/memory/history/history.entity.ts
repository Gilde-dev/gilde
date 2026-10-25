import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One indexed source (a job, run, lesson or feedback row): what is in the vector store for it. Chunk ids derive from it. */
@Entity({ name: 'history_entries' })
@Index(['scanKind', 'seenPass'])
export class HistoryEntry {

    /** `<sourceType>:<sourceId>` */
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ name: 'scan_kind', type: 'varchar', length: 16 })
    scanKind: string;

    @Column({ name: 'source_type', type: 'varchar', length: 16 })
    sourceType: string;

    @Column({ name: 'source_id', type: 'varchar' })
    sourceId: string;

    @Column({ name: 'project_id', type: 'varchar' })
    projectId: string;

    @Column({ name: 'content_hash', type: 'varchar', length: 64 })
    contentHash: string;

    @Column({ name: 'chunk_count', type: 'integer' })
    chunkCount: number;

    /** The pass that last saw this source eligible; entries a finished pass did not see are pruned. */
    @Column({ name: 'seen_pass', type: 'varchar', nullable: true })
    seenPass: string | null;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}

export interface HistoryPassStats {
    indexed: number;
    unchanged: number;
    removed: number;
    embeddedChunks: number;
}

/** Persistent reconciliation progress (a single row), so a restart resumes the pass where it stopped. */
@Entity({ name: 'history_state' })
export class HistoryState {

    @PrimaryColumn({ type: 'varchar' })
    id: string;

    /** The running pass, or null between passes. */
    @Column({ name: 'pass_id', type: 'varchar', nullable: true })
    passId: string | null;

    @Column({ name: 'scan_kind', type: 'varchar', length: 16, nullable: true })
    scanKind: string | null;

    /** `scan` pages through the source rows; `prune` removes entries whose source is gone or no longer eligible. */
    @Column({ type: 'varchar', length: 8, default: 'scan' })
    phase: string;

    /** Last source id of the last fully processed batch. */
    @Column({ type: 'varchar', nullable: true })
    cursor: string | null;

    @Column({ name: 'pass_started_at', type: Date, nullable: true })
    passStartedAt: Date | null;

    @Column({ name: 'last_completed_at', type: Date, nullable: true })
    lastCompletedAt: Date | null;

    /** Embedding model and dimension the index was built with; a change rebuilds it. */
    @Column({ name: 'index_signature', type: 'varchar', nullable: true })
    indexSignature: string | null;

    @Column({ name: 'last_error', type: 'text', nullable: true })
    lastError: string | null;

    @Column({ name: 'last_error_at', type: Date, nullable: true })
    lastErrorAt: Date | null;

    @Column({ name: 'consecutive_failures', type: 'integer', default: 0 })
    consecutiveFailures: number;

    @Column({ type: 'simple-json', nullable: true })
    stats: HistoryPassStats | null;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
