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

    /** Start one automatic conflict-fix round per PR head when an agent PR gets merge conflicts. */
    @Column({
        name: 'auto_fix_conflicts',
        default: false
    })
    autoFixConflicts: boolean;

    /** Queue a Werkmeester planning run when a spec version is approved. */
    @Column({
        name: 'auto_plan',
        default: false
    })
    autoPlan: boolean;

    /** Review agent PRs automatically once CI is green. Off by default; runtime setup alone never enables it. */
    @Column({
        name: 'auto_review',
        default: false
    })
    autoReview: boolean;

    /** Estimated-USD limit per UTC day for this project's agent runs; null = no limit, 0 = stop immediately. */
    @Column({
        name: 'daily_budget_usd',
        type: 'double precision',
        nullable: true
    })
    dailyBudgetUsd: number | null;

    /** Estimated-USD limit per UTC ISO week (Monday start); null = no limit, 0 = stop immediately. */
    @Column({
        name: 'weekly_budget_usd',
        type: 'double precision',
        nullable: true
    })
    weeklyBudgetUsd: number | null;

    /** Percentage of a limit at which a budget turns soft (a warning); > 0 and <= 100. */
    @Column({
        name: 'budget_soft_pct',
        type: 'double precision',
        default: 80
    })
    budgetSoftPct: number;

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
        type: 'uuid',
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