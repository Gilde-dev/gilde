import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One saved body of a spec. Immutable: rows are inserted and never updated (every column is `update: false`). */
@Entity({ name: 'spec_versions' })
@Index('IDX_spec_versions_spec_version', ['specId', 'version'], { unique: true })
export class SpecVersion {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'spec_id', type: 'uuid', update: false })
    specId: string;

    @Column({ type: 'integer', update: false })
    version: number;

    @Column({ update: false })
    title: string;

    /** Stored exactly as received. */
    @Column({ type: 'text', update: false })
    body: string;

    /** SHA-256 of the UTF-8 bytes of `body`. */
    @Column({ name: 'body_sha256', type: 'varchar', length: 64, update: false })
    bodySha256: string;

    /** Numbers of the acceptance criteria in this body (AC-<n>), for the cross-version id rules. */
    @Column({ name: 'criteria_numbers', type: 'simple-json', update: false })
    criteriaNumbers: number[];

    @Column({ name: 'created_by', type: 'uuid', nullable: true, update: false })
    createdById: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
