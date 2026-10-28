import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Links an approved version to the job that records it in the repo. One per version. Rows are never deleted; when a
 * newer version replaces the recording, `supersededByRecordingId` says so and the row stays as evidence.
 */
@Entity({ name: 'spec_recordings' })
@Index('IDX_spec_recordings_spec_version', ['specId', 'version'], { unique: true })
@Index('IDX_spec_recordings_job_id', ['jobId'])
export class SpecRecording {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'spec_id', type: 'uuid', update: false })
    specId: string;

    @Column({ name: 'spec_version_id', type: 'uuid', update: false })
    specVersionId: string;

    @Column({ type: 'integer', update: false })
    version: number;

    @Column({ name: 'approval_id', type: 'uuid', update: false })
    approvalId: string;

    /** The recording job. Two rows can name the same job when a triage job was reused for a newer version. */
    @Column({ name: 'job_id', type: 'uuid', update: false })
    jobId: string;

    /** The older recording job this one waits for, when one was in flight (or failed) at approval time. */
    @Column({ name: 'depends_on_job_id', type: 'uuid', nullable: true, update: false })
    dependsOnJobId: string | null;

    @Column({ name: 'superseded_by_recording_id', type: 'uuid', nullable: true })
    supersededByRecordingId: string | null;

    @Column({ name: 'superseded_at', type: Date, nullable: true })
    supersededAt: Date | null;

    /** Set when a feature pins this recording; a pinned recording is never replaced in place or cancelled. */
    @Column({ name: 'pinned_by_feature_id', type: 'uuid', nullable: true })
    pinnedByFeatureId: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
