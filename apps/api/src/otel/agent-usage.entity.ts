import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One Claude Code `api_request` event received over OTLP. Separate from `llm_usage` (the co-pilot's own calls).
 * `run_id`/`job_id` stay null at ingest; a later pass attributes them. `cost_usd` is Claude Code's own estimate.
 */
export const AGENT_USAGE_ATTRIBUTIONS = ['session', 'time_window'] as const;
export type AgentUsageAttribution = (typeof AGENT_USAGE_ATTRIBUTIONS)[number];

@Entity({ name: 'agent_usage' })
@Index('IDX_agent_usage_event_key', ['eventKey'], { unique: true })
@Index('IDX_agent_usage_session_id', ['sessionId'])
@Index('IDX_agent_usage_event_at', ['eventAt'])
@Index('IDX_agent_usage_run_id', ['runId'])
@Index('IDX_agent_usage_job_id', ['jobId'])
export class AgentUsage {

    @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_agent_usage' })
    id: string;

    @Column({ name: 'run_id', type: 'uuid', nullable: true })
    runId: string | null;

    @Column({ name: 'job_id', type: 'uuid', nullable: true })
    jobId: string | null;

    /** How `run_id` was found: `session` (exact `job_runs.session_id`), `time_window` (the one run fired shortly before the session started) or null (unattributed). */
    @Column({ type: 'varchar', nullable: true })
    attribution: AgentUsageAttribution | null;

    /** The Claude Code session (OTLP `session.id`); not a Gilde id. */
    @Column({ name: 'session_id', type: 'varchar' })
    sessionId: string;

    @Column({ type: 'varchar' })
    model: string;

    /** Uncached input tokens; cache reads and cache creation are separate columns. */
    @Column({ name: 'input_tokens', type: 'integer', default: 0 })
    inputTokens: number;

    @Column({ name: 'output_tokens', type: 'integer', default: 0 })
    outputTokens: number;

    @Column({ name: 'cache_read_tokens', type: 'integer', default: 0 })
    cacheReadTokens: number;

    @Column({ name: 'cache_creation_tokens', type: 'integer', default: 0 })
    cacheCreationTokens: number;

    @Column({ name: 'cost_usd', type: 'double precision', nullable: true })
    costUsd: number | null;

    @Column({ name: 'duration_ms', type: 'double precision', nullable: true })
    durationMs: number | null;

    @Column({ name: 'event_at', type: Date })
    eventAt: Date;

    /** sha256 over session, full-precision timestamp and a producer sequence or allowlisted fingerprint. */
    @Column({ name: 'event_key', type: 'varchar' })
    eventKey: string;

    @Column({ name: 'service_version', type: 'varchar', nullable: true })
    serviceVersion: string | null;

    @Column({ name: 'organization_id', type: 'varchar', nullable: true })
    organizationId: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
