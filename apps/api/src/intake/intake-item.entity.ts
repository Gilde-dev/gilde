import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn, type Relation } from 'typeorm';

import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';

export const INTAKE_SOURCES = ['github_issue'] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

/** A trusted member's comment on the issue, kept as data for the Verfijner. */
export interface IntakeComment {
    /** GitHub's comment id. */
    id: string;
    author: string;
    /** At most INTAKE_COMMENT_LIMIT characters. */
    body: string;
    createdAt: string;
}

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

    /** Comments from OWNER, MEMBER and COLLABORATOR, oldest first; see capComments. */
    @Column({ type: 'simple-json', default: '[]' })
    comments: IntakeComment[];

    /** GitHub id and url of Gilde's one status comment on the issue. */
    @Column({ name: 'status_comment_id', type: 'varchar', nullable: true })
    statusCommentId: string | null;

    @Column({ name: 'status_comment_url', type: 'text', nullable: true })
    statusCommentUrl: string | null;

    /** sha256 of the content last written to the status comment. */
    @Column({ name: 'status_comment_sha256', type: 'varchar', length: 64, nullable: true })
    statusCommentSha256: string | null;

    /** When the status comment was last written, for the one-write-per-minute limit. */
    @Column({ name: 'status_comment_written_at', type: Date, nullable: true })
    statusCommentWrittenAt: Date | null;

    /** A write was held back by the rate limit and is retried by the minute job. */
    @Column({ name: 'status_comment_pending', type: 'boolean', default: false })
    statusCommentPending: boolean;

    /** Short and safe; set when GitHub refused the status comment, cleared by the next successful write. */
    @Column({ name: 'comment_error', type: 'text', nullable: true })
    commentError: string | null;

    /** Hidden from the default lists when set; archiving never deletes or changes anything else. */
    @Column({ name: 'archived_at', type: Date, nullable: true })
    archivedAt: Date | null;

    @Column({ name: 'archived_by_id', type: 'uuid', nullable: true })
    archivedById: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
