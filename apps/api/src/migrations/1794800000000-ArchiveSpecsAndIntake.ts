import { MigrationInterface, QueryRunner } from "typeorm";

/** Archiving of specs and intake items: hides them from the default lists, deletes nothing. Additive only. */
export class ArchiveSpecsAndIntake1794800000000 implements MigrationInterface {
    name = 'ArchiveSpecsAndIntake1794800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "specs" ADD "archived_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "specs" ADD "archived_by_id" uuid`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "archived_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "intake_items" ADD "archived_by_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "archived_by_id"`);
        await queryRunner.query(`ALTER TABLE "intake_items" DROP COLUMN "archived_at"`);
        await queryRunner.query(`ALTER TABLE "specs" DROP COLUMN "archived_by_id"`);
        await queryRunner.query(`ALTER TABLE "specs" DROP COLUMN "archived_at"`);
    }
}
