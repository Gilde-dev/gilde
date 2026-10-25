import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn, type Relation } from "typeorm";
import { Repo } from "../repo/repo.entity.js";

export const SKILLS_LIBRARY_KINDS = ['none', 'folder', 'repo'] as const;
export type SkillsLibraryKind = (typeof SKILLS_LIBRARY_KINDS)[number];

@Entity({
    name: 'projects'
})
export class Project {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    slug: string;

    @Column()
    name: string;

    @Column({
        type: 'text',
        nullable: true
    })
    description: string | null;

    @Column({
        name: 'daily_run_limit',
        default: 20
    })
    dailyRunLimit: number;

    @Column({
        name: 'max_attempts',
        default: 3
    })
    maxAttempts: number;

    @Column({
        name: 'run_timeout_minutes',
        default: 60
    })
    runTimeoutMinutes: number;

    @Column({
        name: 'retry_on_changes_requested',
        default: true
    })
    retryOnChangesRequested: boolean;

    @Column({
        default: false
    })
    paused: boolean;

    @Column({
        name: 'skills_library',
        type: 'simple-enum',
        enum: SKILLS_LIBRARY_KINDS,
        default: 'none'
    })
    skillsLibrary: SkillsLibraryKind;

    /** The repo holding the skills library; only set when skillsLibrary is 'repo'. */
    @Column({
        name: 'skills_library_repo_id',
        type: 'varchar',
        nullable: true
    })
    skillsLibraryRepoId: string | null;

    @OneToMany(() => Repo, (repo) => repo.project)
    repos?: Relation<Repo[]>;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;

}