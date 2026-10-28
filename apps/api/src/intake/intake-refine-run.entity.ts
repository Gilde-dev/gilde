import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One start of the Verfijner on an intake item. Counted per project and UTC day against REFINE_DAILY_LIMIT. */
@Entity({ name: 'intake_refine_runs' })
@Index('IDX_intake_refine_runs_project_started', ['projectId', 'startedAt'])
export class IntakeRefineRun {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid', update: false })
    projectId: string;

    @Column({ name: 'item_id', type: 'uuid', update: false })
    itemId: string;

    @CreateDateColumn({ name: 'started_at' })
    startedAt: Date;
}
