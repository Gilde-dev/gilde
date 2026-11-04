import { MigrationInterface, QueryRunner } from "typeorm";

/** Manifest sync status per repo (ok, missing, invalid, unreachable). Additive only. */
export class RepoManifestStatus1796000000000 implements MigrationInterface {
    name = 'RepoManifestStatus1796000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."repositories_manifest_status_enum" AS ENUM('ok', 'missing', 'invalid', 'unreachable')`);
        await queryRunner.query(`ALTER TABLE "repositories" ADD "manifest_status" "public"."repositories_manifest_status_enum"`);
        await queryRunner.query(`UPDATE "repositories" SET "manifest_status" = 'ok' WHERE "manifest_sha" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repositories" DROP COLUMN "manifest_status"`);
        await queryRunner.query(`DROP TYPE "public"."repositories_manifest_status_enum"`);
    }
}
