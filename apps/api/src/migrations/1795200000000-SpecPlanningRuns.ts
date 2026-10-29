import { MigrationInterface, QueryRunner } from "typeorm";

/** Werkmeester planning runs per spec version, the autoPlan project setting and the spec plan note. Additive only. */
export class SpecPlanningRuns1795200000000 implements MigrationInterface {
    name = 'SpecPlanningRuns1795200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."spec_planning_runs_status_enum" AS ENUM('queued', 'running', 'planned', 'skipped', 'failed')`);
        await queryRunner.query(`CREATE TYPE "public"."spec_planning_runs_trigger_enum" AS ENUM('auto', 'manual')`);
        await queryRunner.query(`CREATE TABLE "spec_planning_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "spec_id" uuid NOT NULL, "version" integer NOT NULL, "approval_id" uuid NOT NULL, "project_id" uuid NOT NULL, "status" "public"."spec_planning_runs_status_enum" NOT NULL DEFAULT 'queued', "attempts" integer NOT NULL DEFAULT '0', "feature_id" uuid, "reason" text, "trigger" "public"."spec_planning_runs_trigger_enum" NOT NULL, "requested_by" uuid, "started_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_spec_planning_runs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_spec_planning_runs_open_version" ON "spec_planning_runs" ("spec_id", "version") WHERE status IN ('queued', 'running')`);
        await queryRunner.query(`CREATE INDEX "IDX_spec_planning_runs_project_status" ON "spec_planning_runs" ("project_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_spec_planning_runs_spec" ON "spec_planning_runs" ("spec_id") `);
        await queryRunner.query(`ALTER TABLE "projects" ADD "auto_plan" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "specs" ADD "plan_note" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "specs" DROP COLUMN "plan_note"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "auto_plan"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_spec_planning_runs_spec"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_spec_planning_runs_project_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_spec_planning_runs_open_version"`);
        await queryRunner.query(`DROP TABLE "spec_planning_runs"`);
        await queryRunner.query(`DROP TYPE "public"."spec_planning_runs_trigger_enum"`);
        await queryRunner.query(`DROP TYPE "public"."spec_planning_runs_status_enum"`);
    }
}
