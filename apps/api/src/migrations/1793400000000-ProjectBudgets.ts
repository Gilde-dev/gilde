import { MigrationInterface, QueryRunner } from "typeorm";

/** Estimated-USD day/week budgets per project and the percentage at which they turn soft. */
export class ProjectBudgets1793400000000 implements MigrationInterface {
    name = 'ProjectBudgets1793400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD "daily_budget_usd" double precision`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "weekly_budget_usd" double precision`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "budget_soft_pct" double precision NOT NULL DEFAULT '80'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "budget_soft_pct"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "weekly_budget_usd"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "daily_budget_usd"`);
    }
}
