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
