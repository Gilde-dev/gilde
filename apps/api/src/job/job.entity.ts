import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { JOB_STATUSES, type JobStatus } from './job-state.js';

@Entity({ name: 'jobs' })
@Index(['repoId', 'status'])
@Index(['projectId', 'status'])
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
        name: 'queued_at'
    })
    queuedAt: Date;

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

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;
}