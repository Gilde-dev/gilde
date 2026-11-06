import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import type { AdditionAgentId } from './agent-additions.render.js';

/** A previous version of a project's additional instructions: written when the next version replaces it. */
@Entity({ name: 'project_agent_instruction_versions' })
@Index('IDX_project_agent_instruction_versions_project_agent', ['projectId', 'agentId', 'version'])
export class ProjectAgentInstructionVersion {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ name: 'agent', type: 'varchar', length: 32 })
    agentId: AdditionAgentId;

    @Column({ type: 'integer' })
    version: number;

    @Column({ type: 'text' })
    text: string;

    /** Who wrote this version, and when. */
    @Column({ name: 'updated_by', type: 'uuid' })
    updatedById: string;

    @Column({ name: 'updated_at', type: Date })
    updatedAt: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
