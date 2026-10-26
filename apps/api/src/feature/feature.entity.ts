import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { FEATURE_STATUSES, type FeatureStatus } from './feature-state.js';

@Entity({ name: 'features' })
@Index(['projectId', 'status'])
export class Feature {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'project_id'
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
