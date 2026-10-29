import { MigrationInterface, QueryRunner } from "typeorm";

/** Which MCP servers contributed knowledge snippets to a run's prompt. Additive only. */
export class RunKnowledge1795100000000 implements MigrationInterface {
    name = 'RunKnowledge1795100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_runs" ADD "knowledge" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_runs" DROP COLUMN "knowledge"`);
    }
}
