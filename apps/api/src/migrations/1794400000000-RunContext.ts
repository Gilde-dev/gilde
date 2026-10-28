import { MigrationInterface, QueryRunner } from "typeorm";

/** What the agent had per run: skills, gildeboek version and AGENTS.md hash. Additive only. */
export class RunContext1794400000000 implements MigrationInterface {
    name = 'RunContext1794400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_runs" ADD "context" text`);
        await queryRunner.query(`ALTER TABLE "job_runs" ADD "context_error" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_runs" DROP COLUMN "context_error"`);
        await queryRunner.query(`ALTER TABLE "job_runs" DROP COLUMN "context"`);
    }
}
