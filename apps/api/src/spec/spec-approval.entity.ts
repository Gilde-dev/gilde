import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Durable evidence that a verified human approved one version. At most one per version; never updated or deleted. */
@Entity({ name: 'spec_approvals' })
@Index('IDX_spec_approvals_spec_version', ['specId', 'version'], { unique: true })
export class SpecApproval {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'spec_id', type: 'uuid', update: false })
    specId: string;

    @Column({ name: 'spec_version_id', type: 'uuid', update: false })
    specVersionId: string;

    @Column({ type: 'integer', update: false })
    version: number;

    /** The approving user; the name and email below are what they were at that moment. */
    @Column({ name: 'approved_by', type: 'uuid', nullable: true, update: false })
    approvedById: string | null;

    @Column({ name: 'approved_by_name', update: false })
    approvedByName: string;

    @Column({ name: 'approved_by_email', update: false })
    approvedByEmail: string;

    @Column({ type: 'varchar', length: 16, update: false })
    credential: string;

    @CreateDateColumn({ name: 'approved_at' })
    approvedAt: Date;
}
