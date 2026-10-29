import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { AgentId } from './agent-ids.js';
import type { AgentSettingsValues } from './agent-settings.js';

/**
 * The runtime settings of one agent, keyed by agent id. Seeded once from the environment (never overwritten from it) and
 * changed by verified humans through the API. Secrets and infrastructure never live here.
 */
@Entity({ name: 'agent_settings' })
export class AgentSettings {

    @PrimaryColumn({ type: 'varchar', length: 32 })
    id: AgentId;

    @Column({ type: 'boolean', default: false })
    enabled: boolean;

    /** The bot user a Verkenner, Verfijner or Werkmeester acts as; null for the other agents. */
    @Column({ name: 'bot_user_id', type: 'uuid', nullable: true })
    botUserId: string | null;

    /** `openai/<model>`; null for the agents without a model, and for a bot agent that follows the co-pilot's model. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    model: string | null;

    @Column({ type: 'simple-json' })
    settings: AgentSettingsValues;

    /** The human who made the last change; null for the seed. */
    @Column({ name: 'updated_by', type: 'uuid', nullable: true })
    updatedById: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
