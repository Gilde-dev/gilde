import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { ProjectMcpServer } from './project-mcp-server.entity.js';

export const PROJECT_MCP_TOOL_MODES = ['read', 'write'] as const;
export type ProjectMcpToolMode = (typeof PROJECT_MCP_TOOL_MODES)[number];

/** A tool a server announced in its last test, with the human's allow and read/write choice. Not allowed means not usable. */
@Entity({
    name: 'project_mcp_tools'
})
@Index('IDX_project_mcp_tools_server_name', ['serverId', 'name'], { unique: true })
export class ProjectMcpTool {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'server_id', type: 'uuid' })
    serverId: string;

    @ManyToOne(() => ProjectMcpServer, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'server_id' })
    server?: ProjectMcpServer;

    @Column({ length: 200 })
    name: string;

    @Column({ type: 'text', default: '' })
    description: string;

    @Column({ type: 'varchar', length: 8, default: 'write' })
    mode: ProjectMcpToolMode;

    @Column({ default: false })
    allowed: boolean;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

}
