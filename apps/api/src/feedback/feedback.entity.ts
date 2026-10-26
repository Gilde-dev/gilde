import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const FEEDBACK_KINDS = ['review', 'review_comment', 'comment'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

@Entity({ name: 'feedback' })
@Index(['kind', 'githubId'], { unique: true })
@Index(['jobId', 'createdAt'])
@Index(['projectId', 'repoId', 'createdAt'])
export class Feedback {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'job_id', type: 'uuid' })
    jobId: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ name: 'repo_id', type: 'uuid' })
    repoId: string;

    @Column({ name: 'pr_number', type: 'integer' })
    prNumber: number;

    @Column({ type: 'simple-enum', enum: FEEDBACK_KINDS })
    kind: FeedbackKind;

    @Column({ name: 'github_id' })
    githubId: string;

    @Column()
    author: string;

    @Column({ name: 'author_association' })
    authorAssociation: string;

    @Column({ type: 'varchar', nullable: true })
    state: string | null;

    @Column({ name: 'review_id', type: 'varchar', nullable: true })
    reviewId: string | null;

    @Column({ type: 'text', nullable: true })
    path: string | null;

    @Column({ type: 'integer', nullable: true })
    line: number | null;

    @Column({ type: 'text', default: '' })
    body: string;

    @Column({ type: 'text' })
    url: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
