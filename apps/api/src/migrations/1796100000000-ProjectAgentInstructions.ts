import { MigrationInterface, QueryRunner } from "typeorm";

/** Per-project additional instructions for Gilde's agents with their version history, and the version of the addition on each agent run. Additive only. */
export class ProjectAgentInstructions1796100000000 implements MigrationInterface {
    name = 'ProjectAgentInstructions1796100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "project_agent_instructions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "agent" character varying(32) NOT NULL, "text" text NOT NULL, "version" integer NOT NULL, "updated_by" uuid NOT NULL, "updated_at" TIMESTAMP NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_project_agent_instructions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_project_agent_instructions_project_agent" ON "project_agent_instructions" ("project_id", "agent") `);
        await queryRunner.query(`CREATE TABLE "project_agent_instruction_versions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "agent" character varying(32) NOT NULL, "version" integer NOT NULL, "text" text NOT NULL, "updated_by" uuid NOT NULL, "updated_at" TIMESTAMP NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_project_agent_instruction_versions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_project_agent_instruction_versions_project_agent" ON "project_agent_instruction_versions" ("project_id", "agent", "version") `);
        await queryRunner.query(`ALTER TABLE "agent_runs" ADD "instructions_addition_version" integer`);
        await queryRunner.query(`ALTER TABLE "agent_runs" ADD "prompt_version" character varying(16)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "prompt_version"`);
        await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "instructions_addition_version"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_agent_instruction_versions_project_agent"`);
        await queryRunner.query(`DROP TABLE "project_agent_instruction_versions"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_project_agent_instructions_project_agent"`);
        await queryRunner.query(`DROP TABLE "project_agent_instructions"`);
    }
}
