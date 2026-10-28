import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * What one user created through MCP on one UTC day (`day` is `YYYY-MM-DD`), across all projects and credentials. Counters
 * only go up through a conditional update in the same transaction as the creation, so a rolled-back creation consumes
 * nothing and concurrent callers cannot exceed the daily limits.
 */
@Entity({ name: 'mcp_usage_days' })
@Index('IDX_mcp_usage_days_user_day', ['userId', 'day'], { unique: true })
export class McpUsageDay {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'user_id', type: 'uuid' })
    userId: string;

    @Column({ type: 'varchar', length: 10 })
    day: string;

    @Column({ name: 'jobs_created', type: 'integer', default: 0 })
    jobsCreated: number;

    @Column({ name: 'features_created', type: 'integer', default: 0 })
    featuresCreated: number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
