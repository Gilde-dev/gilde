import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const SPEC_STATUSES = ['draft', 'approved'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** A versioned document per repo. Repo, project and slug never change after creation. */
@Entity({ name: 'specs' })
@Index('IDX_specs_repo_slug', ['repoId', 'slug'], { unique: true })
@Index('IDX_specs_project_id', ['projectId'])
export class Spec {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid', update: false })
    projectId: string;

    @Column({ name: 'repo_id', type: 'uuid', update: false })
    repoId: string;

    @Column({ type: 'varchar', length: 64, update: false })
    slug: string;

    @Column()
    title: string;

    /** `approved` while the current version is the approved one; saving a new version returns the spec to `draft`. */
    @Column({ type: 'simple-enum', enum: SPEC_STATUSES, default: 'draft' })
    status: SpecStatus;

    @Column({ name: 'current_version', type: 'integer' })
    currentVersion: number;

    /** The newest version a verified human approved; kept when a later draft is saved. */
    @Column({ name: 'approved_version', type: 'integer', nullable: true })
    approvedVersion: number | null;

    @Column({ name: 'created_by', type: 'uuid', nullable: true, update: false })
    createdById: string | null;

    @Column({ name: 'updated_by', type: 'uuid', nullable: true })
    updatedById: string | null;

    @Column({ name: 'approved_by', type: 'uuid', nullable: true })
    approvedById: string | null;

    @Column({ name: 'approved_at', type: Date, nullable: true })
    approvedAt: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
