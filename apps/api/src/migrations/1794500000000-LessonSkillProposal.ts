import { MigrationInterface, QueryRunner } from "typeorm";

/** Lesson target kind `library_skill` and the skill name a proposal gives its lessons. Additive only. */
export class LessonSkillProposal1794500000000 implements MigrationInterface {
    name = 'LessonSkillProposal1794500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."lessons_target_kind_enum" ADD VALUE IF NOT EXISTS 'library_skill'`);
        await queryRunner.query(`ALTER TABLE "lessons" ADD "applied_skill_name" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Enum values cannot be dropped in Postgres; the unused value is harmless.
        await queryRunner.query(`ALTER TABLE "lessons" DROP COLUMN "applied_skill_name"`);
    }
}
