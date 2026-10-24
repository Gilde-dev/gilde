import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { LESSON_STATUSES, type LessonStatus } from './lesson-state.js';

export const LESSON_TARGET_KINDS = ['skill', 'agents_md', 'routine_prompt', 'other'] as const;
export type LessonTargetKind = (typeof LESSON_TARGET_KINDS)[number];

@Entity({ name: 'lessons' })
@Index(['projectId', 'status'])
export class Lesson {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id' })
    projectId: string;

    @Column({ type: 'text' })
    text: string;

    @Column({ type: 'simple-enum', enum: LESSON_STATUSES, default: 'candidate' })
    status: LessonStatus;

    @Column({ name: 'target_kind', type: 'simple-enum', enum: LESSON_TARGET_KINDS, nullable: true })
    targetKind: LessonTargetKind | null;

    @Column({ name: 'target_repo_id', type: 'varchar', nullable: true })
    targetRepoId: string | null;

    @Column({ type: 'text', nullable: true })
    note: string | null;

    @Column({ name: 'applied_job_id', type: 'varchar', nullable: true })
    appliedJobId: string | null;

    @Column({ name: 'applied_at', type: Date, nullable: true })
    appliedAt: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
