import { MigrationInterface, QueryRunner } from "typeorm";

/** The autoReview project policy; existing projects get false. Additive only. */
export class ProjectAutoReview1795700000000 implements MigrationInterface {
    name = 'ProjectAutoReview1795700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD "auto_review" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "auto_review"`);
    }
}
