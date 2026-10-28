import { MigrationInterface, QueryRunner } from "typeorm";

/** A feature can keep the approved spec version it was planned from. Additive only; existing features stay unlinked. */
export class FeatureSpecPin1793800000000 implements MigrationInterface {
    name = 'FeatureSpecPin1793800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "features" ADD "spec_id" uuid`);
        await queryRunner.query(`ALTER TABLE "features" ADD "spec_version" integer`);
        await queryRunner.query(`ALTER TABLE "features" ADD "spec_pin" text`);
        await queryRunner.query(`CREATE INDEX "IDX_features_spec_id" ON "features" ("spec_id") `);
        // Once a feature is pinned, the pin never changes.
        await queryRunner.query(`CREATE FUNCTION "feature_spec_pin_immutable"() RETURNS trigger AS $$ BEGIN IF OLD."spec_id" IS NOT NULL AND (NEW."spec_id" IS DISTINCT FROM OLD."spec_id" OR NEW."spec_version" IS DISTINCT FROM OLD."spec_version" OR NEW."spec_pin" IS DISTINCT FROM OLD."spec_pin") THEN RAISE EXCEPTION 'the spec pin of a feature is immutable'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
        await queryRunner.query(`CREATE TRIGGER "features_spec_pin_immutable" BEFORE UPDATE ON "features" FOR EACH ROW EXECUTE FUNCTION "feature_spec_pin_immutable"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "features_spec_pin_immutable" ON "features"`);
        await queryRunner.query(`DROP FUNCTION "feature_spec_pin_immutable"()`);
        await queryRunner.query(`DROP INDEX "public"."IDX_features_spec_id"`);
        await queryRunner.query(`ALTER TABLE "features" DROP COLUMN "spec_pin"`);
        await queryRunner.query(`ALTER TABLE "features" DROP COLUMN "spec_version"`);
        await queryRunner.query(`ALTER TABLE "features" DROP COLUMN "spec_id"`);
    }
}
