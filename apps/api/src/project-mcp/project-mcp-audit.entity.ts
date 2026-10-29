import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const PROJECT_MCP_AUDIT_ACTIONS = ['created', 'updated', 'token_replaced', 'tested', 'tools_updated', 'deleted'] as const;
export type ProjectMcpAuditAction = (typeof PROJECT_MCP_AUDIT_ACTIONS)[number];

/** Who changed what on a project's MCP registry, and when. `changes` never contains a token. Rows outlive the server. */
@Entity({
    name: 'project_mcp_audit'
})
export class ProjectMcpAudit {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ name: 'server_id', type: 'uuid' })
    serverId: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ name: 'server_name', length: 80 })
    serverName: string;

    @Column({ name: 'actor_id', type: 'uuid' })
    actorId: string;

    @Column({ name: 'actor_email', length: 200 })
    actorEmail: string;

    @Column({ type: 'varchar', length: 24 })
    action: ProjectMcpAuditAction;

    @Column({ type: 'simple-json' })
    changes: Record<string, unknown>;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

}
