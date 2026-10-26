import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const LESSON_SOURCE_KINDS = ['suggested_lesson', 'retro', 'feedback'] as const;
export type LessonSourceKind = (typeof LESSON_SOURCE_KINDS)[number];

/** The unique key of a source: `kind:runId` or `kind:feedbackId`. A plain column, because a unique index over nullable columns doesn't dedupe on SQLite or Postgres. */
export function lessonSourceKey(kind: LessonSourceKind, id: string): string {
    return `${kind}:${id}`;
}

@Entity({ name: 'lesson_sources' })
@Index(['sourceKey'], { unique: true })
@Index(['lessonId'])
export class LessonSource {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'lesson_id', type: 'uuid' })
    lessonId: string;

    @Column({ name: 'source_key' })
    sourceKey: string;

    @Column({ type: 'simple-enum', enum: LESSON_SOURCE_KINDS })
    kind: LessonSourceKind;

    @Column({ name: 'job_id', type: 'uuid' })
    jobId: string;

    @Column({ name: 'run_id', type: 'uuid', nullable: true })
    runId: string | null;

    @Column({ name: 'feedback_id', type: 'uuid', nullable: true })
    feedbackId: string | null;

    @Column({ type: 'text' })
    excerpt: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
