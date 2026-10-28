import { MigrationInterface, QueryRunner } from "typeorm";

/** Cached lesson text embeddings for pattern grouping. Additive only. */
export class LessonEmbeddings1794400000000 implements MigrationInterface {
    name = 'LessonEmbeddings1794400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "lesson_embeddings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "text_hash" character varying(64) NOT NULL, "model" character varying(200) NOT NULL, "vector" text NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_lesson_embeddings" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_lesson_embeddings_hash_model" ON "lesson_embeddings" ("text_hash", "model") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_lesson_embeddings_hash_model"`);
        await queryRunner.query(`DROP TABLE "lesson_embeddings"`);
    }
}
