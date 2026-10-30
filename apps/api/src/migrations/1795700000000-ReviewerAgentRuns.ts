import { MigrationInterface, QueryRunner } from "typeorm";

/** The `pr_review` trigger kind of agent runs (the reviewer agent id needs no change: agent_id is a varchar). */
export class ReviewerAgentRuns1795700000000 implements MigrationInterface {
    name = 'ReviewerAgentRuns1795700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."agent_runs_trigger_kind_enum" ADD VALUE IF NOT EXISTS 'pr_review'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "agent_runs" WHERE "trigger_kind" = 'pr_review' OR "agent_id" = 'reviewer'`);
        await queryRunner.query(`ALTER TYPE "public"."agent_runs_trigger_kind_enum" RENAME TO "agent_runs_trigger_kind_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."agent_runs_trigger_kind_enum" AS ENUM('chat', 'signal', 'schedule', 'intake_item', 'spec_version', 'dispatch', 'mcp_call')`);
        await queryRunner.query(`ALTER TABLE "agent_runs" ALTER COLUMN "trigger_kind" TYPE "public"."agent_runs_trigger_kind_enum" USING "trigger_kind"::"text"::"public"."agent_runs_trigger_kind_enum"`);
        await queryRunner.query(`DROP TYPE "public"."agent_runs_trigger_kind_enum_old"`);
    }
}
