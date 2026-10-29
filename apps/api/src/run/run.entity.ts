import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import type { RunContext } from './run-context.js';
import type { RunKnowledge } from './run-knowledge.js';
import type { GildeResult } from '../webhook/pr-body.js';
import { RUN_STATUSES, type RunKind, type RunStatus } from './run-status.js';

@Entity({ name: 'job_runs' })
@Index(['jobId', 'attempt'], { unique: true })
export class JobRun {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'job_id', type: 'uuid'
    })
    jobId: string;

    @Column({
        name: 'project_id', type: 'uuid'
    })
    projectId: string;

    @Column({
        name: 'repo_id', type: 'uuid'
    })
    repoId: string;

    @Column({ type: 'integer' })
    attempt: number;

    /** A conflict-fix round does not count toward the project's max attempts. */
    @Column({ type: 'varchar', length: 16, default: 'attempt' })
    kind: RunKind;

    /** The executor that ran this attempt; null for runs from before personal executors. */
    @Column({
        name: 'executor_id',
        type: 'uuid',
        nullable: true
    })
    executorId: string | null;

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

    @Column({
        name: 'instructions_version',
        type: 'varchar',
        length: 16,
        nullable: true
    })
    instructionsVersion: string | null;

    /** What the agent had when fired (skills, gildeboek version, AGENTS.md hash); null when not recorded. */
    @Column({ type: 'simple-json', nullable: true })
    context: RunContext | null;

    /** MCP servers whose snippets were in the prompt; null when none were. */
    @Column({ type: 'simple-json', nullable: true })
    knowledge: RunKnowledge[] | null;

    /** Why `context` could not be captured: short, no secrets. */
    @Column({
        name: 'context_error',
        type: 'text',
        nullable: true
    })
    contextError: string | null;

    @Column({ type: 'text', nullable: true })
    error: string | null;

    @Column({ type: 'simple-json', nullable: true })
    result: GildeResult | null;

    @Column({
        name: 'result_error',
        type: 'text',
        nullable: true
    })
    resultError: string | null;

    @Column({
        name: 'proposals_error',
        type: 'text',
        nullable: true
    })
    proposalsError: string | null;

    @Column({ type: 'text', nullable: true })
    retro: string | null;

    @Column({
        name: 'ci_conclusion',
        type: 'varchar',
        length: 32,
        nullable: true
    })
    ciConclusion: string | null;

    @Column({
        name: 'fired_at',
        type: Date,
        nullable: true
    })
    firedAt: Date | null;

    @Column({
        name: 'finished_at',
        type: Date,
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
