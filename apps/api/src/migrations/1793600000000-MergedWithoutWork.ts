import { MigrationInterface, QueryRunner } from "typeorm";

/** merged_blocked (merged on GitHub, latest run blocked) with a backfill, and recreated_from_id for "Recreate job". */
export class MergedWithoutWork1793600000000 implements MigrationInterface {
    name = 'MergedWithoutWork1793600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "merged_blocked" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "recreated_from_id" uuid`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_jobs_recreated_from_id" ON "jobs" ("recreated_from_id")`);
        // Backfill from the stored results: a merged job whose latest attempt reported blocked.
        await queryRunner.query(`
            UPDATE "jobs" SET "merged_blocked" = true
            WHERE "status" = 'merged' AND EXISTS (
                SELECT 1 FROM "job_runs" r
                WHERE r."job_id" = "jobs"."id"
                  AND r."attempt" = (SELECT MAX(l."attempt") FROM "job_runs" l WHERE l."job_id" = "jobs"."id")
                  AND r."result" LIKE '%"outcome":"blocked"%'
            )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_jobs_recreated_from_id"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "recreated_from_id"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "merged_blocked"`);
    }
}
