import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn, type Relation } from 'typeorm';
import { Project } from '../project/project.entity.js';

export const STACKS = ['spring-boot', 'nestjs', 'nextjs', 'node', 'other'] as const;
export type Stack = (typeof STACKS)[number];

@Entity({
    name: 'repositories'
})
export class Repo {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column()
    projectId: string;

    @ManyToOne(() => Project, (project) => project.repos, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'project_id' })
    project?: Relation<Project>;

    @Column({ unique: true })
    fullName: string;

    @Column({
        name: 'default_branch',
        default: 'main'
    })
    defaultBranch: string;

    /** Cached from .gilde.json in the repo; empty until the first successful manifest refresh. */
    @Column({ type: 'simple-json', default: '[]' })
    stacks: Stack[];

    @Column({ name: 'test_commands', type: 'simple-json', default: '[]' })
    testCommands: string[];

    @Column({ type: 'simple-json', nullable: true })
    skills: { include?: string[]; exclude?: string[] } | null;

    @Column({ name: 'manifest_sha', type: 'text', nullable: true })
    manifestSha: string | null;

    @Column({ name: 'manifest_synced_at', type: 'datetime', nullable: true })
    manifestSyncedAt: Date | null;

    @Column({ name: 'manifest_error', type: 'text', nullable: true })
    manifestError: string | null;

    @Column({
        name: 'routine_fire_url',
        type: 'text',
        nullable: true
    })
    routineFireUrl: string | null;

    @Column({
        name: 'routine_token_env',
        type: 'text',
        nullable: true
    })
    routineTokenEnv: string | null;

    @Column({
        name: 'max_concurrent_jobs',
        default: 2
    })
    maxConcurrentJobs: number;

    @Column({ default: false })
    paused: boolean;

    @Column({ name: 'paused_reason', type: 'text', nullable: true })
    pausedReason: string | null;

    @CreateDateColumn({
        name: 'created_at'
    })
    createdAt: Date;

    @UpdateDateColumn({
        name: 'updated_at'
    })
    updatedAt: Date;

}