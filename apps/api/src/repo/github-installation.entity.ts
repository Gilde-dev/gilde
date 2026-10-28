import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Whether the Gilde GitHub App is installed on a repo, from installation webhooks. Display only; never creates or removes repos. */
@Entity({ name: 'github_installations' })
export class GithubInstallation {
    /** owner/name, lowercase. */
    @PrimaryColumn({ name: 'full_name' })
    fullName: string;

    @Column({ default: true })
    installed: boolean;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
