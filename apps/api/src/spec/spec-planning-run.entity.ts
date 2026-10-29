import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const PLANNING_RUN_STATUSES = ['queued', 'running', 'planned', 'skipped', 'failed'] as const;
export type PlanningRunStatus = (typeof PLANNING_RUN_STATUSES)[number];

export const PLANNING_RUN_TRIGGERS = ['auto', 'manual'] as const;
export type PlanningRunTrigger = (typeof PLANNING_RUN_TRIGGERS)[number];

/** A run in one of these statuses is not final yet. At most one exists per spec version. */
export const OPEN_PLANNING_STATUSES: PlanningRunStatus[] = ['queued', 'running'];

/**
 * One request for the Werkmeester to plan an approved spec version. The partial unique index is the race-safe guard: two
 * approvals, clicks or processes cannot both hold an open run for the same version. A final run stays as evidence, so a
 * `failed` or `skipped` version can be requested again.
 */
@Entity({ name: 'spec_planning_runs' })
@Index('IDX_spec_planning_runs_open_version', ['specId', 'version'], { unique: true, where: "status IN ('queued', 'running')" })
@Index('IDX_spec_planning_runs_project_status', ['projectId', 'status'])
@Index('IDX_spec_planning_runs_spec', ['specId'])
export class SpecPlanningRun {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'spec_id', type: 'uuid', update: false })
    specId: string;

    @Column({ type: 'integer', update: false })
    version: number;

    @Column({ name: 'approval_id', type: 'uuid', update: false })
    approvalId: string;

    @Column({ name: 'project_id', type: 'uuid', update: false })
    projectId: string;

    @Column({ type: 'simple-enum', enum: PLANNING_RUN_STATUSES, default: 'queued' })
    status: PlanningRunStatus;

    /** Starts of the Werkmeester for this run; a run fails after the second. */
    @Column({ type: 'integer', default: 0 })
    attempts: number;

    @Column({ name: 'feature_id', type: 'uuid', nullable: true })
    featureId: string | null;

    /** Short reason of a skipped or failed run (no secrets). */
    @Column({ type: 'text', nullable: true })
    reason: string | null;

    @Column({ type: 'simple-enum', enum: PLANNING_RUN_TRIGGERS, update: false })
    trigger: PlanningRunTrigger;

    /** The human who clicked "Plan from spec"; null for an automatic run. */
    @Column({ name: 'requested_by', type: 'uuid', nullable: true, update: false })
    requestedById: string | null;

    /** When the latest attempt started; counted per project and UTC day against PLAN_DAILY_LIMIT. */
    @Column({ name: 'started_at', type: Date, nullable: true })
    startedAt: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
