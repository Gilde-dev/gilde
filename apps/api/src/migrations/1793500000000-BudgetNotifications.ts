import { MigrationInterface, QueryRunner } from "typeorm";

/** budget.soft / budget.hard notification kinds and the structured budget facts they carry. */
export class BudgetNotifications1793500000000 implements MigrationInterface {
    name = 'BudgetNotifications1793500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" ADD VALUE IF NOT EXISTS 'budget.soft'`);
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" ADD VALUE IF NOT EXISTS 'budget.hard'`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD "budget" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "budget"`);
        await queryRunner.query(`DELETE FROM "notifications" WHERE "kind" IN ('budget.soft', 'budget.hard')`);
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" RENAME TO "notifications_kind_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."notifications_kind_enum" AS ENUM('job.awaiting_review', 'job.parked', 'job.approval_needed', 'revision.waiting', 'feature.ready_to_close')`);
        await queryRunner.query(`ALTER TABLE "notifications" ALTER COLUMN "kind" TYPE "public"."notifications_kind_enum" USING "kind"::"text"::"public"."notifications_kind_enum"`);
        await queryRunner.query(`DROP TYPE "public"."notifications_kind_enum_old"`);
    }
}
