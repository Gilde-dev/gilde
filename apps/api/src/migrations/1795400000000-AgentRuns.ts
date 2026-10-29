import { MigrationInterface, QueryRunner } from "typeorm";

/** The uniform agent run log: agent_runs and agent_tool_calls. Additive only. */
export class AgentRuns1795400000000 implements MigrationInterface {
    name = 'AgentRuns1795400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."agent_runs_trigger_kind_enum" AS ENUM('chat', 'signal', 'schedule', 'intake_item', 'spec_version', 'dispatch', 'mcp_call')`);
        await queryRunner.query(`CREATE TYPE "public"."agent_runs_outcome_enum" AS ENUM('ok', 'error', 'refused', 'skipped')`);
        await queryRunner.query(`CREATE TABLE "agent_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "agent_id" character varying(32) NOT NULL, "trigger_kind" "public"."agent_runs_trigger_kind_enum" NOT NULL, "trigger_ref_type" character varying(32), "trigger_ref_id" character varying(128), "actor_user_id" uuid, "project_id" uuid, "started_at" TIMESTAMP NOT NULL, "ended_at" TIMESTAMP, "outcome" "public"."agent_runs_outcome_enum", "reason" text, "model" character varying(128), "input_tokens" integer, "output_tokens" integer, "cost_usd" double precision, "linked_table" character varying(32), "linked_id" character varying(64), "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_agent_runs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_agent_runs_agent_started" ON "agent_runs" ("agent_id", "started_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_agent_runs_started" ON "agent_runs" ("started_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_agent_runs_linked" ON "agent_runs" ("linked_table", "linked_id") `);
        await queryRunner.query(`CREATE TABLE "agent_tool_calls" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "run_id" uuid NOT NULL, "tool_name" character varying(128) NOT NULL, "input" text, "output" text, "duration_ms" integer, "error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_agent_tool_calls" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_agent_tool_calls_run" ON "agent_tool_calls" ("run_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_tool_calls_run"`);
        await queryRunner.query(`DROP TABLE "agent_tool_calls"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_runs_linked"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_runs_started"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_runs_agent_started"`);
        await queryRunner.query(`DROP TABLE "agent_runs"`);
        await queryRunner.query(`DROP TYPE "public"."agent_runs_outcome_enum"`);
        await queryRunner.query(`DROP TYPE "public"."agent_runs_trigger_kind_enum"`);
    }
}
