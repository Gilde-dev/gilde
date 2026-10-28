import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { User } from '../user/user.entity.js';
import { JOB_STATUSES, type JobStatus } from './job-state.js';

@Entity({ name: 'jobs' })
@Index(['repoId', 'status'])
@Index(['projectId', 'status'])
@Index(['featureId'])
@Index('IDX_jobs_recreated_from_id', ['recreatedFromId'], { unique: true })
export class Job {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'project_id', type: 'uuid'
    })
    projectId: string;

    @Column({
        name: 'repo_id', type: 'uuid'
    })
    repoId: string;

    @Column({
        name: 'feature_id',
        type: 'uuid',
        nullable: true
    })
    featureId: string | null;

    @Column()
    title: string;

    @Column({ type: 'text' })
    task: string;

    @Column({
        name: 'acceptance_criteria',
        type: 'simple-json',
        default: '[]'
    })
    acceptanceCriteria: string[];

    @Column({ type: 'simple-enum', enum: JOB_STATUSES, default: 'queued' })
    status: JobStatus;

    @Column({ default: 0 })
    attempts: number;

    @Column({
        name: 'queued_at',
        type: Date,
        nullable: true
    })
    queuedAt: Date | null;

    @Column({
        name: 'pr_number',
        type: 'integer',
        nullable: true
    })
    prNumber: number | null;

    @Column({
        name: 'pr_url',
        type: 'text',
        nullable: true
    })
    prUrl: string | null;

    @Column({ type: 'text', nullable: true })
    branch: string | null;

    @Column({
        name: 'head_sha',
        type: 'varchar',
        length: 64,
        nullable: true
    })
    headSha: string | null;

    @Column({
        name: 'last_reason',
        type: 'text',
        nullable: true
    })
    lastReason: string | null;

    @Column({
        name: 'needs_approval',
        default: false
    })
    needsApproval: boolean;

    @Column({
        name: 'approval_reason',
        type: 'text',
        nullable: true
    })
    approvalReason: string | null;

    /**
     * True while the job is merged and the result of its latest run reports `blocked`: the PR was merged on GitHub but no
     * work was done. Kept in sync by JobEventsService whenever a result is written or the job is merged.
     */
    @Column({
        name: 'merged_blocked',
        default: false
    })
    mergedBlocked: boolean;

    /** Set on a job made by "Recreate job": the merged-without-work job it replaces. Unique, so a job has one replacement. */
    @Column({
        name: 'recreated_from_id',
        type: 'uuid',
        nullable: true
    })
    recreatedFromId: string | null;

    /** The user who created the job; null for system-created jobs and when the user was deleted. */
    @Column({
        name: 'created_by',
        type: 'uuid',
        nullable: true
    })
    createdById: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'created_by' })
    createdBy?: User | null;

    /** The human who last queued the job through the state machine; the owner when the creator is a bot or unknown. */
    @Column({
        name: 'queued_by_id',
        type: 'uuid',
        nullable: true
    })
    queuedById: string | null;

    /** Why the dispatcher could not fire this queued job on an executor of its owner yet; null otherwise. */
    @Column({
        name: 'waiting_reason',
        type: 'text',
        nullable: true
    })
    waitingReason: string | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;
}