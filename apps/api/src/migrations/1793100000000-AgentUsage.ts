import { MigrationInterface, QueryRunner } from "typeorm";

/** Claude Code telemetry received over OTLP (`agent_usage`), separate from the co-pilot's `llm_usage`. */
export class AgentUsage1793100000000 implements MigrationInterface {
    name = 'AgentUsage1793100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "agent_usage" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "run_id" uuid, "job_id" uuid, "session_id" character varying NOT NULL, "model" character varying NOT NULL, "input_tokens" integer NOT NULL DEFAULT '0', "output_tokens" integer NOT NULL DEFAULT '0', "cache_read_tokens" integer NOT NULL DEFAULT '0', "cache_creation_tokens" integer NOT NULL DEFAULT '0', "cost_usd" double precision, "duration_ms" double precision, "event_at" TIMESTAMP NOT NULL, "event_key" character varying NOT NULL, "service_version" character varying, "organization_id" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_agent_usage" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_agent_usage_event_key" ON "agent_usage" ("event_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_agent_usage_session_id" ON "agent_usage" ("session_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_agent_usage_event_at" ON "agent_usage" ("event_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_agent_usage_run_id" ON "agent_usage" ("run_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_agent_usage_job_id" ON "agent_usage" ("job_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_usage_job_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_usage_run_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_usage_event_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_usage_session_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_usage_event_key"`);
        await queryRunner.query(`DROP TABLE "agent_usage"`);
    }
}
