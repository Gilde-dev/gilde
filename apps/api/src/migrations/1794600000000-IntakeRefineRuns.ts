import { MigrationInterface, QueryRunner } from "typeorm";

/** Starts of the Verfijner per intake item, for its daily limit. Additive only. */
export class IntakeRefineRuns1794600000000 implements MigrationInterface {
    name = 'IntakeRefineRuns1794600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "intake_refine_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "item_id" uuid NOT NULL, "started_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_intake_refine_runs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_intake_refine_runs_project_started" ON "intake_refine_runs" ("project_id", "started_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_intake_refine_runs_project_started"`);
        await queryRunner.query(`DROP TABLE "intake_refine_runs"`);
    }
}
