import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per project, locked by the first statement of every suggestion transaction (`UPDATE ... SET version = version + 1`).
 * On Postgres that row lock serializes the quota, hash and title checks of all callers and processes of a project; on SQLite
 * the write lock does. Holds no data of its own.
 */
@Entity({ name: 'scout_suggestion_guards' })
@Index(['projectId'], { unique: true })
export class ScoutSuggestionGuard {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'project_id', type: 'uuid' })
    projectId: string;

    @Column({ type: 'integer', default: 0 })
    version: number;
}
