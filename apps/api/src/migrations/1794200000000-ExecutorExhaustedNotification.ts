import { MigrationInterface, QueryRunner } from "typeorm";

/** executor.exhausted notification kind. */
export class ExecutorExhaustedNotification1794200000000 implements MigrationInterface {
    name = 'ExecutorExhaustedNotification1794200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" ADD VALUE IF NOT EXISTS 'executor.exhausted'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "notifications" WHERE "kind" = 'executor.exhausted'`);
        await queryRunner.query(`ALTER TYPE "public"."notifications_kind_enum" RENAME TO "notifications_kind_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."notifications_kind_enum" AS ENUM('job.awaiting_review', 'job.parked', 'job.approval_needed', 'revision.waiting', 'feature.ready_to_close', 'budget.soft', 'budget.hard')`);
        await queryRunner.query(`ALTER TABLE "notifications" ALTER COLUMN "kind" TYPE "public"."notifications_kind_enum" USING "kind"::"text"::"public"."notifications_kind_enum"`);
        await queryRunner.query(`DROP TYPE "public"."notifications_kind_enum_old"`);
    }
}
