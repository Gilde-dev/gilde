import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Receipt of one job the scout suggested: project, job, acting user, the hash of its canonical evidence set and the time.
 * Written in the same transaction as the job. The hash is unique per project and is never deleted, so it keeps refusing the
 * same evidence set whatever later happens to the job. `jobId` is deliberately not a foreign key for that reason.
 */
@Entity({ name: 'scout_suggestions' })
@Index(['projectId', 'evidenceHash'], { unique: true })
@Index(['projectId', 'day'])
export class ScoutSuggestion {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ name: 'job_id', type: 'uuid' })
    jobId: string;

    @Column({ name: 'actor_id', type: 'uuid' })
    actorId: string;

    /** SHA-256 (hex) of the sorted, unique, lower-case evidence ids. */
    @Column({ name: 'evidence_hash', type: 'varchar', length: 64 })
    evidenceHash: string;

    /** The UTC day (`YYYY-MM-DD`) of the suggestion: what the daily quota and the weekly count are keyed on, whatever the server's time zone. */
    @Column({ type: 'varchar', length: 10 })
    day: string;

    @Column({ name: 'created_at', type: Date })
    createdAt: Date;
}
