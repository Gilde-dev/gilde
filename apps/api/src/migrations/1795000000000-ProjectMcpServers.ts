import { MigrationInterface, QueryRunner } from "typeorm";

/** Project MCP server registry: servers with encrypted tokens, their tools (allowlist) and an audit trail. Additive only. */
export class ProjectMcpServers1795000000000 implements MigrationInterface {
    name = 'ProjectMcpServers1795000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "project_mcp_servers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "name" character varying(80) NOT NULL, "url" character varying(500) NOT NULL, "token_ciphertext" text, "token_iv" character varying(32), "token_tag" character varying(32), "key_version" integer NOT NULL DEFAULT '1', "token_last4" character varying(4), "enabled" boolean NOT NULL DEFAULT true, "unattended_enabled" boolean NOT NULL DEFAULT false, "knowledge_enabled" boolean NOT NULL DEFAULT false, "knowledge_tool" character varying(200), "knowledge_query_arg" character varying(100), "last_tested_at" TIMESTAMP, "last_error" character varying(500), "last_error_at" TIMESTAMP, "call_count" integer NOT NULL DEFAULT '0', "error_count" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_project_mcp_servers" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_project_mcp_servers_project_id" ON "project_mcp_servers" ("project_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_project_mcp_servers_project_name" ON "project_mcp_servers" ("project_id", "name") `);
        await queryRunner.query(`ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "FK_project_mcp_servers_project_id" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE TABLE "project_mcp_tools" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "server_id" uuid NOT NULL, "name" character varying(200) NOT NULL, "description" text NOT NULL DEFAULT '', "mode" character varying(8) NOT NULL DEFAULT 'write', "allowed" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_project_mcp_tools" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_project_mcp_tools_server_name" ON "project_mcp_tools" ("server_id", "name") `);
        await queryRunner.query(`ALTER TABLE "project_mcp_tools" ADD CONSTRAINT "FK_project_mcp_tools_server_id" FOREIGN KEY ("server_id") REFERENCES "project_mcp_servers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE TABLE "project_mcp_audit" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "server_id" uuid NOT NULL, "project_id" uuid NOT NULL, "server_name" character varying(80) NOT NULL, "actor_id" uuid NOT NULL, "actor_email" character varying(200) NOT NULL, "action" character varying(24) NOT NULL, "changes" text NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_project_mcp_audit" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_project_mcp_audit_server_id" ON "project_mcp_audit" ("server_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_project_mcp_audit_server_id"`);
        await queryRunner.query(`DROP TABLE "project_mcp_audit"`);
        await queryRunner.query(`ALTER TABLE "project_mcp_tools" DROP CONSTRAINT "FK_project_mcp_tools_server_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_mcp_tools_server_name"`);
        await queryRunner.query(`DROP TABLE "project_mcp_tools"`);
        await queryRunner.query(`ALTER TABLE "project_mcp_servers" DROP CONSTRAINT "FK_project_mcp_servers_project_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_mcp_servers_project_name"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_mcp_servers_project_id"`);
        await queryRunner.query(`DROP TABLE "project_mcp_servers"`);
    }
}
