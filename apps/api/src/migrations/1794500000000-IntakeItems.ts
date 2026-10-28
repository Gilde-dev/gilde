import { MigrationInterface, QueryRunner } from "typeorm";

/** Intake items: labelled GitHub issues waiting to become draft specs. Additive only. */
export class IntakeItems1794500000000 implements MigrationInterface {
    name = 'IntakeItems1794500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."intake_items_source_enum" AS ENUM('github_issue')`);
        await queryRunner.query(`CREATE TYPE "public"."intake_items_status_enum" AS ENUM('new', 'refining', 'drafted', 'failed', 'withdrawn', 'ignored')`);
        await queryRunner.query(`CREATE TABLE "intake_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "source" "public"."intake_items_source_enum" NOT NULL DEFAULT 'github_issue', "external_id" character varying NOT NULL, "number" integer NOT NULL, "url" text NOT NULL, "title" character varying NOT NULL, "body" text NOT NULL, "body_truncated" boolean NOT NULL DEFAULT false, "body_sha256" character varying(64) NOT NULL, "author_login" character varying, "labels" text NOT NULL DEFAULT '[]', "status" "public"."intake_items_status_enum" NOT NULL DEFAULT 'new', "spec_id" uuid, "last_error" text, "refine_attempts" integer NOT NULL DEFAULT '0', "refined_sha256" character varying(64), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_intake_items" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_intake_items_source_repo_number" ON "intake_items" ("source", "repo_id", "number") `);
        await queryRunner.query(`CREATE INDEX "IDX_intake_items_project_id" ON "intake_items" ("project_id") `);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD CONSTRAINT "FK_intake_items_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD CONSTRAINT "FK_intake_items_repo" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "intake_items" DROP CONSTRAINT "FK_intake_items_repo"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP CONSTRAINT "FK_intake_items_project"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_intake_items_project_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_intake_items_source_repo_number"`);
        await queryRunner.query(`DROP TABLE "intake_items"`);
        await queryRunner.query(`DROP TYPE "public"."intake_items_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."intake_items_source_enum"`);
    }
}
