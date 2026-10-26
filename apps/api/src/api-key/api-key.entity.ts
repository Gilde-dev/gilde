import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '../user/user.entity.js';

@Entity({
    name: 'api_keys'
})
export class ApiKey {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ name: 'user_id', type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user?: User;

    @Column()
    name: string;

    @Index({ unique: true })
    @Column()
    prefix: string;

    /** sha256 hex of the secret. Only loaded when selected explicitly. */
    @Column({ name: 'secret_hash', select: false })
    secretHash: string;

    @Column({ name: 'last_used_at', type: Date, nullable: true })
    lastUsedAt: Date | null;

    @Column({ name: 'expires_at', type: Date, nullable: true })
    expiresAt: Date | null;

    @Column({ name: 'revoked_at', type: Date, nullable: true })
    revokedAt: Date | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

}
