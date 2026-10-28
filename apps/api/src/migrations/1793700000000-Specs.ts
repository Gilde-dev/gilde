import { MigrationInterface, QueryRunner } from "typeorm";

/** Specs, their immutable versions and the per-version approval and recording audit. Additive only. */
export class Specs1793700000000 implements MigrationInterface {
    name = 'Specs1793700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."specs_status_enum" AS ENUM('draft', 'approved')`);
        await queryRunner.query(`CREATE TABLE "specs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "slug" character varying(64) NOT NULL, "title" character varying NOT NULL, "status" "public"."specs_status_enum" NOT NULL DEFAULT 'draft', "current_version" integer NOT NULL, "approved_version" integer, "created_by" uuid, "updated_by" uuid, "approved_by" uuid, "approved_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_specs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_specs_repo_slug" ON "specs" ("repo_id", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_specs_project_id" ON "specs" ("project_id") `);
        await queryRunner.query(`CREATE TABLE "spec_versions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "spec_id" uuid NOT NULL, "version" integer NOT NULL, "title" character varying NOT NULL, "body" text NOT NULL, "body_sha256" character varying(64) NOT NULL, "criteria_numbers" text NOT NULL, "created_by" uuid, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_spec_versions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_spec_versions_spec_version" ON "spec_versions" ("spec_id", "version") `);
        await queryRunner.query(`CREATE TABLE "spec_approvals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "spec_id" uuid NOT NULL, "spec_version_id" uuid NOT NULL, "version" integer NOT NULL, "approved_by" uuid, "approved_by_name" character varying NOT NULL, "approved_by_email" character varying NOT NULL, "credential" character varying(16) NOT NULL, "approved_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_spec_approvals" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_spec_approvals_spec_version" ON "spec_approvals" ("spec_id", "version") `);
        await queryRunner.query(`CREATE TABLE "spec_recordings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "spec_id" uuid NOT NULL, "spec_version_id" uuid NOT NULL, "version" integer NOT NULL, "approval_id" uuid NOT NULL, "job_id" uuid NOT NULL, "depends_on_job_id" uuid, "superseded_by_recording_id" uuid, "superseded_at" TIMESTAMP, "pinned_by_feature_id" uuid, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_spec_recordings" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_spec_recordings_spec_version" ON "spec_recordings" ("spec_id", "version") `);
        await queryRunner.query(`CREATE INDEX "IDX_spec_recordings_job_id" ON "spec_recordings" ("job_id") `);
        // Evidence is append-only: a version body is never rewritten and an approval is never changed or erased.
        await queryRunner.query(`CREATE FUNCTION "spec_evidence_immutable"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql`);
        await queryRunner.query(`CREATE TRIGGER "spec_versions_immutable" BEFORE UPDATE OR DELETE ON "spec_versions" FOR EACH ROW EXECUTE FUNCTION "spec_evidence_immutable"()`);
        await queryRunner.query(`CREATE TRIGGER "spec_approvals_immutable" BEFORE UPDATE OR DELETE ON "spec_approvals" FOR EACH ROW EXECUTE FUNCTION "spec_evidence_immutable"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "spec_approvals_immutable" ON "spec_approvals"`);
        await queryRunner.query(`DROP TRIGGER "spec_versions_immutable" ON "spec_versions"`);
        await queryRunner.query(`DROP FUNCTION "spec_evidence_immutable"()`);
        await queryRunner.query(`DROP INDEX "public"."IDX_spec_recordings_job_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_spec_recordings_spec_version"`);
        await queryRunner.query(`DROP TABLE "spec_recordings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_spec_approvals_spec_version"`);
        await queryRunner.query(`DROP TABLE "spec_approvals"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_spec_versions_spec_version"`);
        await queryRunner.query(`DROP TABLE "spec_versions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_specs_project_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_specs_repo_slug"`);
        await queryRunner.query(`DROP TABLE "specs"`);
        await queryRunner.query(`DROP TYPE "public"."specs_status_enum"`);
    }
}
