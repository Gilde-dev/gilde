import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const USER_AUDIT_ACTIONS = ['user_created', 'reset_link_created', 'setup_completed', 'deactivated', 'reactivated', 'admin_granted', 'admin_revoked'] as const;
export type UserAuditAction = (typeof USER_AUDIT_ACTIONS)[number];

/** Who did what to which account, and when. Rows are never updated or deleted. */
@Entity({ name: 'user_audit_log' })
export class UserAudit {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The admin; for setup_completed the account itself. */
    @Column({ name: 'actor_id', type: 'uuid' })
    actorId: string;

    @Index()
    @Column({ name: 'target_user_id', type: 'uuid' })
    targetUserId: string;

    @Column({ type: 'simple-enum', enum: USER_AUDIT_ACTIONS })
    action: UserAuditAction;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

}
