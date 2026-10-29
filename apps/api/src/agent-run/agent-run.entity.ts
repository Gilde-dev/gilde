import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** The agents and bots whose runs are logged. Ids of the Mastra agents are their agent ids. */
export const AGENT_RUN_AGENTS = ['gilde', 'verkenner', 'verfijner', 'werkmeester', 'mcp', 'coding'] as const;
export type AgentRunAgent = (typeof AGENT_RUN_AGENTS)[number];

export const AGENT_RUN_TRIGGERS = ['chat', 'signal', 'schedule', 'intake_item', 'spec_version', 'dispatch', 'mcp_call'] as const;
export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];

export const AGENT_RUN_OUTCOMES = ['ok', 'error', 'refused', 'skipped'] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

/**
 * One run of an agent: a co-pilot request, a scout wake, a Verfijner or Werkmeester run, an MCP tool call or a coding-agent
 * job run. `outcome` is null while the run is going. The existing per-agent tables keep working; `linkedTable` and `linkedId`
 * point at their row. Nothing here holds message content: tool inputs and outputs are in `agent_tool_calls`, redacted and capped.
 */
@Entity({ name: 'agent_runs' })
@Index('IDX_agent_runs_agent_started', ['agentId', 'startedAt'])
@Index('IDX_agent_runs_started', ['startedAt'])
@Index('IDX_agent_runs_linked', ['linkedTable', 'linkedId'])
export class AgentRun {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'agent_id', type: 'varchar', length: 32 })
    agentId: AgentRunAgent;

    @Column({ name: 'trigger_kind', type: 'simple-enum', enum: AGENT_RUN_TRIGGERS })
    triggerKind: AgentRunTrigger;

    /** What started the run (`intake_item`, `spec`, `job`, `thread`, `project`, `tool`); with `triggerRefId` it makes the trigger linkable. */
    @Column({ name: 'trigger_ref_type', type: 'varchar', length: 32, nullable: true })
    triggerRefType: string | null;

    @Column({ name: 'trigger_ref_id', type: 'varchar', length: 128, nullable: true })
    triggerRefId: string | null;

    /** The acting user or bot. */
    @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
    actorUserId: string | null;

    @Column({ name: 'project_id', type: 'uuid', nullable: true })
    projectId: string | null;

    @Column({ name: 'started_at', type: Date })
    startedAt: Date;

    @Column({ name: 'ended_at', type: Date, nullable: true })
    endedAt: Date | null;

    @Column({ type: 'simple-enum', enum: AGENT_RUN_OUTCOMES, nullable: true })
    outcome: AgentRunOutcome | null;

    /** Short reason of a non-ok outcome (redacted, capped). */
    @Column({ type: 'text', nullable: true })
    reason: string | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    model: string | null;

    @Column({ name: 'input_tokens', type: 'integer', nullable: true })
    inputTokens: number | null;

    @Column({ name: 'output_tokens', type: 'integer', nullable: true })
    outputTokens: number | null;

    @Column({ name: 'cost_usd', type: 'double precision', nullable: true })
    costUsd: number | null;

    /** The per-agent record of this run: `intake_refine_runs`, `spec_planning_runs` or `job_runs`. */
    @Column({ name: 'linked_table', type: 'varchar', length: 32, nullable: true })
    linkedTable: string | null;

    @Column({ name: 'linked_id', type: 'varchar', length: 64, nullable: true })
    linkedId: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
