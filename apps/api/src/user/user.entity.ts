import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity({
    name: 'users'
})
export class User {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    /** Stored lowercased and trimmed. */
    @Column({ unique: true })
    email: string;

    /** Machine accounts (channels, Verkenner). Never eligible for human-only operations. */
    @Column({ name: 'is_bot', type: 'boolean', default: false })
    isBot: boolean;

    /** May manage users and change agent runtime settings. Granted with the admin API or the user:make-admin CLI. */
    @Column({ name: 'is_admin', type: 'boolean', default: false })
    isAdmin: boolean;

    /** Set when the account is deactivated: no login, JWTs and API keys stop working, history stays. */
    @Column({ name: 'deactivated_at', type: Date, nullable: true })
    deactivatedAt: Date | null;

    @Column({ name: 'deactivated_by_id', type: 'uuid', nullable: true })
    deactivatedById: string | null;

    /** The argon2id hash. Only loaded when selected explicitly. */
    @Column({ select: false })
    password: string;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;

}
