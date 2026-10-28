import { MigrationInterface, QueryRunner } from "typeorm";

/** Personal executors with encrypted routine tokens. Additive only. */
export class Executors1794000000000 implements MigrationInterface {
    name = 'Executors1794000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."executors_kind_enum" AS ENUM('routine')`);
        await queryRunner.query(`CREATE TABLE "executors" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "owner_id" uuid NOT NULL, "name" character varying(80) NOT NULL, "kind" "public"."executors_kind_enum" NOT NULL DEFAULT 'routine', "fire_url" character varying NOT NULL, "token_ciphertext" text, "token_iv" character varying(32), "token_tag" character varying(32), "key_version" integer NOT NULL DEFAULT '1', "token_last4" character varying(4), "repo_ids" text NOT NULL, "max_concurrent" integer NOT NULL DEFAULT '1', "daily_run_limit" integer, "enabled" boolean NOT NULL DEFAULT true, "exhausted_until" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_executors" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_executors_owner_id" ON "executors" ("owner_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_executors_owner_name" ON "executors" ("owner_id", "name") `);
        await queryRunner.query(`ALTER TABLE "executors" ADD CONSTRAINT "FK_executors_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "executors" DROP CONSTRAINT "FK_executors_owner_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_executors_owner_name"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_executors_owner_id"`);
        await queryRunner.query(`DROP TABLE "executors"`);
        await queryRunner.query(`DROP TYPE "public"."executors_kind_enum"`);
    }
}
