import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SetupTokenPurpose = 'setup' | 'reset';

/** A one-time link to set a password: only the sha256 of the token is stored, the plaintext is shown once to the admin. */
@Entity({ name: 'user_setup_tokens' })
export class UserSetupToken {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ name: 'user_id', type: 'uuid' })
    userId: string;

    @Index({ unique: true })
    @Column({ name: 'token_hash' })
    tokenHash: string;

    @Column({ type: 'simple-enum', enum: ['setup', 'reset'] })
    purpose: SetupTokenPurpose;

    @Column({ name: 'expires_at', type: Date })
    expiresAt: Date;

    @Column({ name: 'used_at', type: Date, nullable: true })
    usedAt: Date | null;

    @Column({ name: 'created_by_id', type: 'uuid' })
    createdById: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

}
