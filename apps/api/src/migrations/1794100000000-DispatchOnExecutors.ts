import { MigrationInterface, QueryRunner } from "typeorm";

/** Job owner (queued_by), the dispatcher's waiting reason and the executor of a run. Additive only; old runs keep a null executor. */
export class DispatchOnExecutors1794100000000 implements MigrationInterface {
    name = 'DispatchOnExecutors1794100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "queued_by_id" uuid`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "waiting_reason" text`);
        await queryRunner.query(`ALTER TABLE "job_runs" ADD "executor_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_runs" DROP COLUMN "executor_id"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "waiting_reason"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "queued_by_id"`);
    }
}
