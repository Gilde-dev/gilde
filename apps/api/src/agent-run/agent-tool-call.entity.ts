import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One tool call of a Gilde agent in a run. Input and output are redacted and capped (`AGENT_LOG_MAX_CHARS`): never secrets, never the full payload. */
@Entity({ name: 'agent_tool_calls' })
@Index('IDX_agent_tool_calls_run', ['runId'])
export class AgentToolCall {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'run_id', type: 'uuid' })
    runId: string;

    @Column({ name: 'tool_name', type: 'varchar', length: 128 })
    toolName: string;

    @Column({ type: 'text', nullable: true })
    input: string | null;

    @Column({ type: 'text', nullable: true })
    output: string | null;

    @Column({ name: 'duration_ms', type: 'integer', nullable: true })
    durationMs: number | null;

    @Column({ type: 'text', nullable: true })
    error: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
