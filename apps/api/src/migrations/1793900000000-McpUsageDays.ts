import { MigrationInterface, QueryRunner } from "typeorm";

/** Daily MCP creation bookkeeping per user. Additive only. */
export class McpUsageDays1793900000000 implements MigrationInterface {
    name = 'McpUsageDays1793900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mcp_usage_days" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "day" character varying(10) NOT NULL, "jobs_created" integer NOT NULL DEFAULT '0', "features_created" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_mcp_usage_days" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_mcp_usage_days_user_day" ON "mcp_usage_days" ("user_id", "day") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_mcp_usage_days_user_day"`);
        await queryRunner.query(`DROP TABLE "mcp_usage_days"`);
    }
}
