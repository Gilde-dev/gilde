import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const REVISION_STATUSES = ['proposed', 'accepted', 'rejected'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

/** A change to a job proposed by an agent. Null content fields mean unchanged. */
@Entity({ name: 'job_revisions' })
@Index(['jobId', 'status'])
export class JobRevision {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'job_id'
    })
    jobId: string;

    /** Number within the job, assigned when accepted. */
    @Column({ type: 'integer', nullable: true })
    revision: number | null;

    @Column({ type: 'varchar', length: 200, nullable: true })
    title: string | null;

    @Column({ type: 'text', nullable: true })
    task: string | null;

    @Column({
        name: 'acceptance_criteria',
        type: 'simple-json',
        nullable: true
    })
    acceptanceCriteria: string[] | null;

    @Column({
        name: 'depends_on',
        type: 'simple-json',
        nullable: true
    })
    dependsOn: string[] | null;

    @Column({ type: 'text' })
    reason: string;

    @Column({
        name: 'source_run_id',
        type: 'varchar',
        nullable: true
    })
    sourceRunId: string | null;

    @Column({ type: 'simple-enum', enum: REVISION_STATUSES, default: 'proposed' })
    status: RevisionStatus;

    @Column({
        name: 'decided_at',
        type: Date,
        nullable: true
    })
    decidedAt: Date | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;
}
