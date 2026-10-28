import { MigrationInterface, QueryRunner } from "typeorm";

/** Persisted bot flag on users; existing accounts stay human. */
export class UserIsBot1793600000000 implements MigrationInterface {
    name = 'UserIsBot1793600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "is_bot" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_bot"`);
    }
}
