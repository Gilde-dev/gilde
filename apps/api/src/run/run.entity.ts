import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { RUN_STATUSES, type RunStatus } from './run-status.js';

@Entity({ name: 'job_runs' })
@Index(['jobId', 'attempt'], { unique: true })
export class JobRun {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'job_id'
    })
    jobId: string;

    @Column({
        name: 'project_id'
    })
    projectId: string;

    @Column({
        name: 'repo_id'
    })
    repoId: string;

    @Column({ type: 'integer' })
    attempt: number;

    @Column({ type: 'simple-enum', enum: RUN_STATUSES, default: 'firing' })
    status: RunStatus;

    @Column({
        name: 'session_id',
        type: 'text',
        nullable: true
    })
    sessionId: string | null;

    @Column({
        name: 'session_url',
        type: 'text',
        nullable: true
    })
    sessionUrl: string | null;

    @Column({ type: 'text', nullable: true })
    error: string | null;

    @Column({
        name: 'fired_at',
        nullable: true
    })
    firedAt: Date | null;

    @Column({
        name: 'finished_at',
        nullable: true
    })
    finishedAt: Date | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;
}
