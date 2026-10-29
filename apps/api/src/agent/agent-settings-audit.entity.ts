import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import type { AgentId } from './agent-ids.js';

/** One changed field of one settings change: who changed what from which value to which, and when. */
@Entity({ name: 'agent_settings_audit' })
@Index('IDX_agent_settings_audit_agent_created', ['agent', 'createdAt'])
export class AgentSettingsAudit {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 32, update: false })
    agent: AgentId;

    /** `enabled`, `botUserId`, `model` or `settings.<key>`. */
    @Column({ type: 'varchar', length: 100, update: false })
    field: string;

    /** JSON text of the old and new value; null for no value. */
    @Column({ name: 'old_value', type: 'text', nullable: true, update: false })
    oldValue: string | null;

    @Column({ name: 'new_value', type: 'text', nullable: true, update: false })
    newValue: string | null;

    @Column({ name: 'changed_by', type: 'uuid', update: false })
    changedById: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
