import { MigrationInterface, QueryRunner } from "typeorm";

/** The automatic PR review ledger (pr_reviews) and the durable revision count on jobs. Additive only. */
export class PrReviews1795800000000 implements MigrationInterface {
    name = 'PrReviews1795800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_review_revisions" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_revision_review_id" uuid`);
        await queryRunner.query(`CREATE TABLE "pr_reviews" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "project_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "pr_number" integer NOT NULL, "head_sha" character varying(64) NOT NULL, "base_sha" character varying(64), "base_ref" character varying(255), "status" character varying(16) NOT NULL DEFAULT 'pending', "verdict" character varying(16), "reason_code" character varying(32), "reason" text, "result" text, "limits" text, "model" character varying(128), "input_tokens" integer, "output_tokens" integer, "cost_usd" double precision, "claimed_instance" character varying(64), "started_at" TIMESTAMP, "completed_at" TIMESTAMP, "publication_id" character varying(64), "publication_url" text, "routing_state" character varying(16) NOT NULL DEFAULT 'unclaimed', "routing_action" character varying(16), "routing_claimed_at" TIMESTAMP, "routed_at" TIMESTAMP, "suppressed" boolean NOT NULL DEFAULT false, "overridden_at" TIMESTAMP, "overridden_by_id" uuid, "override_reason" text, "overridden_result" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_pr_reviews" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_pr_reviews_job_pr_head" ON "pr_reviews" ("job_id", "pr_number", "head_sha") `);
        await queryRunner.query(`CREATE INDEX "IDX_pr_reviews_job_created" ON "pr_reviews" ("job_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_pr_reviews_status" ON "pr_reviews" ("status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_pr_reviews_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_pr_reviews_job_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_pr_reviews_job_pr_head"`);
        await queryRunner.query(`DROP TABLE "pr_reviews"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_revision_review_id"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_review_revisions"`);
    }
}
