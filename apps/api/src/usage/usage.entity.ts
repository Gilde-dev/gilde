import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '../user/user.entity.js';

export const USAGE_KINDS = ['chat', 'embedding'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

@Entity({ name: 'llm_usage' })
@Index(['createdAt'])
export class LlmUsage {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'simple-enum', enum: USAGE_KINDS })
    kind: UsageKind;

    @Column({ name: 'user_id', type: 'varchar', nullable: true })
    userId: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'user_id' })
    user?: User | null;

    @Column({ name: 'thread_id', type: 'varchar', nullable: true })
    threadId: string | null;

    @Column({ type: 'varchar', nullable: true })
    agent: string | null;

    @Column()
    model: string;

    @Column({ name: 'input_tokens', type: 'integer', default: 0 })
    inputTokens: number;

    @Column({ name: 'cached_input_tokens', type: 'integer', default: 0 })
    cachedInputTokens: number;

    @Column({ name: 'output_tokens', type: 'integer', default: 0 })
    outputTokens: number;

    @Column({ name: 'reasoning_tokens', type: 'integer', default: 0 })
    reasoningTokens: number;

    @Column({ type: 'integer', nullable: true })
    steps: number | null;

    @Column({ name: 'cost_usd', type: 'double precision', nullable: true })
    costUsd: number | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
