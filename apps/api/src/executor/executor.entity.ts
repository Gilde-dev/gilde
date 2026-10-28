import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { User } from '../user/user.entity.js';

export const EXECUTOR_KINDS = ['routine'] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** A personal executor: one user's named Claude Code routine with the repos it may serve and its own limits. */
@Entity({
    name: 'executors'
})
@Index('IDX_executors_owner_name', ['ownerId', 'name'], { unique: true })
export class Executor {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ name: 'owner_id', type: 'uuid' })
    ownerId: string;

    @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'owner_id' })
    owner?: User;

    @Column({ length: 80 })
    name: string;

    @Column({ type: 'simple-enum', enum: EXECUTOR_KINDS, default: 'routine' })
    kind: ExecutorKind;

    @Column({ name: 'fire_url' })
    fireUrl: string;

    /** AES-256-GCM ciphertext (base64) of the routine token. Never mapped to a DTO; only loaded when selected explicitly. */
    @Column({ name: 'token_ciphertext', type: 'text', nullable: true, select: false })
    tokenCiphertext: string | null;

    @Column({ name: 'token_iv', type: 'varchar', length: 32, nullable: true, select: false })
    tokenIv: string | null;

    @Column({ name: 'token_tag', type: 'varchar', length: 32, nullable: true, select: false })
    tokenTag: string | null;

    /** Version of EXECUTOR_SECRET_KEY the token was encrypted with. Reserved for key rotation (not supported yet). */
    @Column({ name: 'key_version', type: 'integer', default: 1, select: false })
    keyVersion: number;

    /** Last four characters of the token, for display. Null exactly when no token is stored. */
    @Column({ name: 'token_last4', type: 'varchar', length: 4, nullable: true })
    tokenLast4: string | null;

    @Column({ name: 'repo_ids', type: 'simple-json' })
    repoIds: string[];

    @Column({ name: 'max_concurrent', type: 'integer', default: 1 })
    maxConcurrent: number;

    /** Null means no limit of its own. */
    @Column({ name: 'daily_run_limit', type: 'integer', nullable: true })
    dailyRunLimit: number | null;

    @Column({ default: true })
    enabled: boolean;

    @Column({ name: 'exhausted_until', type: Date, nullable: true })
    exhaustedUntil: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

}
