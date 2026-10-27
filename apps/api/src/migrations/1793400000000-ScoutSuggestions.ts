import { MigrationInterface, QueryRunner } from "typeorm";

/** Bookkeeping of the Verkenner scout's suggested jobs: receipts with the evidence hash, and the per-project lock row. */
export class ScoutSuggestions1793400000000 implements MigrationInterface {
    name = 'ScoutSuggestions1793400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "scout_suggestions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "job_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "evidence_hash" character varying(64) NOT NULL, "day" character varying(10) NOT NULL, "created_at" TIMESTAMP NOT NULL, CONSTRAINT "PK_scout_suggestions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_scout_suggestions_project_hash" ON "scout_suggestions" ("project_id", "evidence_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_scout_suggestions_project_day" ON "scout_suggestions" ("project_id", "day") `);
        await queryRunner.query(`CREATE TABLE "scout_suggestion_guards" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "version" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_scout_suggestion_guards" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_scout_suggestion_guards_project" ON "scout_suggestion_guards" ("project_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_scout_suggestion_guards_project"`);
        await queryRunner.query(`DROP TABLE "scout_suggestion_guards"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_scout_suggestions_project_day"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_scout_suggestions_project_hash"`);
        await queryRunner.query(`DROP TABLE "scout_suggestions"`);
    }
}
