import { MigrationInterface, QueryRunner } from "typeorm";

/** spec.planned and spec.plan_failed notification kinds. */
export class SpecPlanNotifications1795300000000 implements MigrationInterface {
    name = 'SpecPlanNotifications1795300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" ADD VALUE IF NOT EXISTS 'spec.planned'`);
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" ADD VALUE IF NOT EXISTS 'spec.plan_failed'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "notifications" WHERE "kind" IN ('spec.planned', 'spec.plan_failed')`);
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" RENAME TO "notifications_kind_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."notifications_kind_enum" AS ENUM('job.awaiting_review', 'job.parked', 'job.approval_needed', 'revision.waiting', 'feature.ready_to_close', 'budget.soft', 'budget.hard', 'executor.exhausted')`);
        await queryRunner.query(`ALTER TABLE "notifications" ALTER COLUMN "kind" TYPE "public"."notifications_kind_enum" USING "kind"::"text"::"public"."notifications_kind_enum"`);
        await queryRunner.query(`DROP TYPE "public"."notifications_kind_enum_old"`);
    }
}
