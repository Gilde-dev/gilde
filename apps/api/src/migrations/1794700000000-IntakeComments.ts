import { MigrationInterface, QueryRunner } from "typeorm";

/** Trusted issue comments and the status comment bookkeeping on intake items. Additive only. */
export class IntakeComments1794700000000 implements MigrationInterface {
    name = 'IntakeComments1794700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "comments" text NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "status_comment_id" character varying`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "status_comment_url" text`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "status_comment_sha256" character varying(64)`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "status_comment_written_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "status_comment_pending" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "comment_error" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "comment_error"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "status_comment_pending"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "status_comment_written_at"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "status_comment_sha256"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "status_comment_url"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "status_comment_id"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "comments"`);
    }
}
