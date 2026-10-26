import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { User } from '../user/user.entity.js';
import { JOB_STATUSES, type JobStatus } from './job-state.js';

@Entity({ name: 'jobs' })
@Index(['repoId', 'status'])
@Index(['projectId', 'status'])
@Index(['featureId'])
export class Job {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'project_id'
    })
    projectId: string;

    @Column({
        name: 'repo_id'
    })
    repoId: string;

    @Column({
        name: 'feature_id',
        type: 'varchar',
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

    /** The user who created the job; null for system-created jobs and when the user was deleted. */
    @Column({
        name: 'created_by',
        type: 'varchar',
        nullable: true
    })
    createdById: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'created_by' })
    createdBy?: User | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;
}