import { MigrationInterface, QueryRunner } from "typeorm";

/** Operator actions on job runs and the operator.actions notification kind. Additive only. */
export class OperatorActions1795900000000 implements MigrationInterface {
    name = 'OperatorActions1795900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_runs" ADD "operator_actions" text`);
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" ADD VALUE IF NOT EXISTS 'operator.actions'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_runs" DROP COLUMN "operator_actions"`);
        await queryRunner.query(`DELETE FROM "notifications" WHERE "kind" = 'operator.actions'`);
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" RENAME TO "notifications_kind_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."notifications_kind_enum" AS ENUM('job.awaiting_review', 'job.parked', 'job.approval_needed', 'revision.waiting', 'feature.ready_to_close', 'budget.soft', 'budget.hard', 'executor.exhausted', 'spec.planned', 'spec.plan_failed')`);
        await queryRunner.query(`ALTER TABLE "notifications" ALTER COLUMN "kind" TYPE "public"."notifications_kind_enum" USING "kind"::"text"::"public"."notifications_kind_enum"`);
        await queryRunner.query(`DROP TYPE "public"."notifications_kind_enum_old"`);
    }
}
