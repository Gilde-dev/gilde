import { MigrationInterface, QueryRunner } from "typeorm";

/** Bookkeeping of the Verkenner scout: published-event receipts and per-project UTC-day wake budgets. */
export class ScoutSignals1793300000000 implements MigrationInterface {
    name = 'ScoutSignals1793300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "scout_signal_receipts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "dedupe_key" character varying(255) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_scout_signal_receipts" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_scout_signal_receipts_project_key" ON "scout_signal_receipts" ("project_id", "dedupe_key") `);
        await queryRunner.query(`CREATE TABLE "scout_wake_days" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "day" character varying(10) NOT NULL, "wakes_used" integer NOT NULL DEFAULT '0', "summary_claimed_at" TIMESTAMP, "last_wake_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_scout_wake_days" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_scout_wake_days_project_day" ON "scout_wake_days" ("project_id", "day") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_scout_wake_days_project_day"`);
        await queryRunner.query(`DROP TABLE "scout_wake_days"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_scout_signal_receipts_project_key"`);
        await queryRunner.query(`DROP TABLE "scout_signal_receipts"`);
    }
}
