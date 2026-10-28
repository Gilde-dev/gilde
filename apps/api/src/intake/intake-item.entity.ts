import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn, type Relation } from 'typeorm';

import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';

export const INTAKE_SOURCES = ['github_issue'] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export const INTAKE_STATUSES = ['new', 'refining', 'drafted', 'failed', 'withdrawn', 'ignored'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** A labelled issue (or other external request) waiting to become a draft spec. Unlabelled issues are never stored. */
@Entity({ name: 'intake_items' })
@Index('IDX_intake_items_source_repo_number', ['source', 'repoId', 'number'], { unique: true })
@Index('IDX_intake_items_project_id', ['projectId'])
export class IntakeItem {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid', update: false })
    projectId: string;

    @ManyToOne(() => Project, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'project_id' })
    project?: Relation<Project>;

    @Column({ name: 'repo_id', type: 'uuid', update: false })
    repoId: string;

    @ManyToOne(() => Repo, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'repo_id' })
    repo?: Relation<Repo>;

    @Column({ type: 'simple-enum', enum: INTAKE_SOURCES, default: 'github_issue', update: false })
    source: IntakeSource;

    /** The issue's GraphQL node id. */
    @Column({ name: 'external_id', type: 'varchar' })
    externalId: string;

    @Column({ type: 'integer', update: false })
    number: number;

    @Column({ type: 'text' })
    url: string;

    @Column({ type: 'varchar' })
    title: string;

    /** At most INTAKE_BODY_LIMIT characters; see bodyTruncated. */
    @Column({ type: 'text' })
    body: string;

    @Column({ name: 'body_truncated', type: 'boolean', default: false })
    bodyTruncated: boolean;

    /** sha256 of title + body (the full body, before the cap). */
    @Column({ name: 'body_sha256', type: 'varchar', length: 64 })
    bodySha256: string;

    @Column({ name: 'author_login', type: 'varchar', nullable: true })
    authorLogin: string | null;

    @Column({ type: 'simple-json', default: '[]' })
    labels: string[];

    @Column({ type: 'simple-enum', enum: INTAKE_STATUSES, default: 'new' })
    status: IntakeStatus;

    @Column({ name: 'spec_id', type: 'uuid', nullable: true })
    specId: string | null;

    /** Short, free of secrets. */
    @Column({ name: 'last_error', type: 'text', nullable: true })
    lastError: string | null;

    @Column({ name: 'refine_attempts', type: 'integer', default: 0 })
    refineAttempts: number;

    /** The body sha the current draft was made from. */
    @Column({ name: 'refined_sha256', type: 'varchar', length: 64, nullable: true })
    refinedSha256: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
