import { MigrationInterface, QueryRunner } from "typeorm";

/** Runtime settings per agent in the database (seeded from the environment at startup) and their audit trail. Additive only. */
export class AgentSettings1795400000000 implements MigrationInterface {
    name = 'AgentSettings1795400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "agent_settings" ("id" character varying(32) NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "bot_user_id" uuid, "model" character varying(200), "settings" text NOT NULL, "updated_by" uuid, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_agent_settings" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "agent_settings_audit" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "agent" character varying(32) NOT NULL, "field" character varying(100) NOT NULL, "old_value" text, "new_value" text, "changed_by" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_agent_settings_audit" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_agent_settings_audit_agent_created" ON "agent_settings_audit" ("agent", "created_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_settings_audit_agent_created"`);
        await queryRunner.query(`DROP TABLE "agent_settings_audit"`);
        await queryRunner.query(`DROP TABLE "agent_settings"`);
    }
}
