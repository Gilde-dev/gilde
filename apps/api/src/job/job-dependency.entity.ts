import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Job } from './job.entity.js';

/** `jobId` waits until `dependsOnJobId` is merged. */
@Entity({ name: 'job_dependencies' })
export class JobDependency {

    @PrimaryColumn({
        name: 'job_id'
    })
    jobId: string;

    @PrimaryColumn({
        name: 'depends_on_job_id'
    })
    dependsOnJobId: string;

    @ManyToOne(() => Job, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'job_id' })
    job?: Job;

    @ManyToOne(() => Job, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'depends_on_job_id' })
    dependsOn?: Job;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;
}
