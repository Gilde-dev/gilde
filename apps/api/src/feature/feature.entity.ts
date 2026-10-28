import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { FEATURE_STATUSES, type FeatureStatus } from './feature-state.js';
import type { FeatureSpecPin } from './feature-spec-pin.js';

@Entity({ name: 'features' })
@Index(['projectId', 'status'])
@Index('IDX_features_spec_id', ['specId'])
export class Feature {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'project_id', type: 'uuid'
    })
    projectId: string;

    @Column()
    title: string;

    @Column({ type: 'text' })
    spec: string;

    @Column({
        name: 'acceptance_criteria',
        type: 'simple-json',
        default: '[]'
    })
    acceptanceCriteria: string[];

    /** The spec this feature was planned from; null for a feature without one. Set once, at creation, and never changed. */
    @Column({ name: 'spec_id', type: 'uuid', nullable: true, update: false })
    specId: string | null;

    /** The approved spec version the plan was made from; never follows later versions. */
    @Column({ name: 'spec_version', type: 'integer', nullable: true, update: false })
    specVersion: number | null;

    /** Immutable snapshot of the pinned version, its approval and its recording at planning time. */
    @Column({ name: 'spec_pin', type: 'simple-json', nullable: true, update: false })
    specPin: FeatureSpecPin | null;

    @Column({ type: 'simple-enum', enum: FEATURE_STATUSES, default: 'draft' })
    status: FeatureStatus;

    @Column({
        name: 'started_at',
        type: Date,
        nullable: true
    })
    startedAt: Date | null;

    @Column({
        name: 'done_at',
        type: Date,
        nullable: true
    })
    doneAt: Date | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;
}
