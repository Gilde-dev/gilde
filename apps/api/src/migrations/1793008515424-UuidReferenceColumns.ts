import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Columns that hold the id of another row were created as varchar while every id is uuid, so Postgres rejected
 * joins and comparisons between them ("operator does not exist: uuid = character varying"). Changes them to uuid
 * in place (indexes are rebuilt by Postgres), keeping existing data.
 */
const COLUMNS: Array<[table: string, column: string]> = [
    ['features', 'project_id'],
    ['feedback', 'job_id'],
    ['feedback', 'project_id'],
    ['feedback', 'repo_id'],
    ['jobs', 'project_id'],
    ['jobs', 'repo_id'],
    ['jobs', 'feature_id'],
    ['lesson_sources', 'lesson_id'],
    ['lesson_sources', 'job_id'],
    ['lesson_sources', 'run_id'],
    ['lesson_sources', 'feedback_id'],
    ['lessons', 'project_id'],
    ['lessons', 'target_repo_id'],
    ['lessons', 'applied_job_id'],
    ['notifications', 'project_id'],
    ['notifications', 'job_id'],
    ['notifications', 'feature_id'],
    ['projects', 'skills_library_repo_id'],
    ['job_revisions', 'job_id'],
    ['job_revisions', 'source_run_id'],
    ['job_runs', 'job_id'],
    ['job_runs', 'project_id'],
    ['job_runs', 'repo_id'],
];

export class UuidReferenceColumns1793008515424 implements MigrationInterface {
    name = 'UuidReferenceColumns1793008515424'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, column] of COLUMNS) {
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE uuid USING "${column}"::uuid`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, column] of [...COLUMNS].reverse()) {
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE character varying`);
        }
    }
}
