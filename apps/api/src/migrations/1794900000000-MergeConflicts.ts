import { MigrationInterface, QueryRunner } from "typeorm";

/** Merge-conflict detection and conflict-fix rounds: flags on jobs, the round kind on runs, autoFixConflicts on projects. */
export class MergeConflicts1794900000000 implements MigrationInterface {
    name = 'MergeConflicts1794900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "merge_conflict" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "merge_conflict_checked_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "next_round_kind" character varying(16)`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_fix_head_sha" character varying(64)`);
        await queryRunner.query(`ALTER TABLE "job_runs" ADD "kind" character varying(16) NOT NULL DEFAULT 'attempt'`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "auto_fix_conflicts" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "auto_fix_conflicts"`);
        await queryRunner.query(`ALTER TABLE "job_runs" DROP COLUMN "kind"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_fix_head_sha"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "next_round_kind"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "merge_conflict_checked_at"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "merge_conflict"`);
    }
}
