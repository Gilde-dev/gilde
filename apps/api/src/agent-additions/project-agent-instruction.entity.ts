import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import type { AdditionAgentId } from './agent-additions.render.js';

/**
 * The current additional instructions of one agent in one project. Empty text means no addition (removed); the version
 * keeps counting, so a version number is never reused. Every replaced version is kept in `project_agent_instruction_versions`.
 */
@Entity({ name: 'project_agent_instructions' })
@Index('UQ_project_agent_instructions_project_agent', ['projectId', 'agentId'], { unique: true })
export class ProjectAgentInstruction {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ name: 'agent', type: 'varchar', length: 32 })
    agentId: AdditionAgentId;

    @Column({ type: 'text' })
    text: string;

    @Column({ type: 'integer' })
    version: number;

    @Column({ name: 'updated_by', type: 'uuid' })
    updatedById: string;

    @Column({ name: 'updated_at', type: Date })
    updatedAt: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
