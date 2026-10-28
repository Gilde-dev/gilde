import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { LESSON_STATUSES, type LessonStatus } from './lesson-state.js';

/** `skill` is legacy: rows that have it still load and apply like `repo_skill`, but it can no longer be set. */
export const LESSON_TARGET_KINDS = ['skill', 'agents_md', 'repo_skill', 'routine_prompt', 'library_skill', 'other'] as const;
export type LessonTargetKind = (typeof LESSON_TARGET_KINDS)[number];
export const SETTABLE_LESSON_TARGET_KINDS = ['agents_md', 'repo_skill', 'routine_prompt', 'library_skill', 'other'] as const;

@Entity({ name: 'lessons' })
@Index(['projectId', 'status'])
export class Lesson {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ type: 'text' })
    text: string;

    @Column({ type: 'simple-enum', enum: LESSON_STATUSES, default: 'candidate' })
    status: LessonStatus;

    @Column({ name: 'target_kind', type: 'simple-enum', enum: LESSON_TARGET_KINDS, nullable: true })
    targetKind: LessonTargetKind | null;

    @Column({ name: 'target_repo_id', type: 'uuid', nullable: true })
    targetRepoId: string | null;

    @Column({ type: 'text', nullable: true })
    note: string | null;

    @Column({ name: 'applied_job_id', type: 'uuid', nullable: true })
    appliedJobId: string | null;

    /** The library skill a `library_skill` lesson is being turned into (set by a skill proposal). */
    @Column({ name: 'applied_skill_name', type: 'varchar', nullable: true })
    appliedSkillName: string | null;

    @Column({ name: 'applied_at', type: Date, nullable: true })
    appliedAt: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
