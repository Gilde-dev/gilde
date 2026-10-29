import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { Project } from '../project/project.entity.js';

/** Version of EXECUTOR_SECRET_KEY the project MCP tokens are encrypted under (its own scope, separate from executors). */
export const PROJECT_MCP_KEY_VERSION = 1;

/** A remote MCP server (Streamable HTTP) a project has registered, with its write-only bearer token. */
@Entity({
    name: 'project_mcp_servers'
})
@Index('IDX_project_mcp_servers_project_name', ['projectId', 'name'], { unique: true })
export class ProjectMcpServer {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @ManyToOne(() => Project, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'project_id' })
    project?: Project;

    @Column({ length: 80 })
    name: string;

    @Column({ length: 500 })
    url: string;

    /** AES-256-GCM ciphertext (base64) of the bearer token. Never mapped to a DTO; only loaded when selected explicitly. */
    @Column({ name: 'token_ciphertext', type: 'text', nullable: true, select: false })
    tokenCiphertext: string | null;

    @Column({ name: 'token_iv', type: 'varchar', length: 32, nullable: true, select: false })
    tokenIv: string | null;

    @Column({ name: 'token_tag', type: 'varchar', length: 32, nullable: true, select: false })
    tokenTag: string | null;

    @Column({ name: 'key_version', type: 'integer', default: PROJECT_MCP_KEY_VERSION, select: false })
    keyVersion: number;

    /** Last four characters of the token, for display. Null exactly when no token is stored. */
    @Column({ name: 'token_last4', type: 'varchar', length: 4, nullable: true })
    tokenLast4: string | null;

    @Column({ default: true })
    enabled: boolean;

    /** Whether the unattended agents (Verkenner, Verfijner) may use this server's read tools. */
    @Column({ name: 'unattended_enabled', default: false })
    unattendedEnabled: boolean;

    /** Knowledge settings for job payloads; set by the dispatch feature, not by this registry. */
    @Column({ name: 'knowledge_enabled', default: false })
    knowledgeEnabled: boolean;

    @Column({ name: 'knowledge_tool', type: 'varchar', length: 200, nullable: true })
    knowledgeTool: string | null;

    @Column({ name: 'knowledge_query_arg', type: 'varchar', length: 100, nullable: true })
    knowledgeQueryArg: string | null;

    @Column({ name: 'last_tested_at', type: Date, nullable: true })
    lastTestedAt: Date | null;

    /** Short, token-free description of the last failure; null after a success. */
    @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
    lastError: string | null;

    @Column({ name: 'last_error_at', type: Date, nullable: true })
    lastErrorAt: Date | null;

    @Column({ name: 'call_count', type: 'integer', default: 0 })
    callCount: number;

    @Column({ name: 'error_count', type: 'integer', default: 0 })
    errorCount: number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

}
