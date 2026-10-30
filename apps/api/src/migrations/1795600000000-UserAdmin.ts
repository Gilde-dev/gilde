import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from "typeorm";

import { seedFirstAdmin } from '../user/admin-seed.js';

/** Admin role, deactivation, one-time setup links and the user audit log. Additive only; seeds the oldest human as admin when there is none. */
export class UserAdmin1795600000000 implements MigrationInterface {
    name = 'UserAdmin1795600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "is_admin" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "users" ADD "deactivated_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "users" ADD "deactivated_by_id" uuid`);
        await queryRunner.query(`CREATE TABLE "user_setup_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "token_hash" character varying NOT NULL, "purpose" character varying NOT NULL, "expires_at" TIMESTAMP NOT NULL, "used_at" TIMESTAMP, "created_by_id" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_user_setup_tokens" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_user_setup_tokens_user_id" ON "user_setup_tokens" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_user_setup_tokens_token_hash" ON "user_setup_tokens" ("token_hash") `);
        await queryRunner.query(`CREATE TABLE "user_audit_log" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actor_id" uuid NOT NULL, "target_user_id" uuid NOT NULL, "action" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_user_audit_log" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_user_audit_log_target_user_id" ON "user_audit_log" ("target_user_id") `);

        const seeded = await seedFirstAdmin(queryRunner);
        new Logger('UserAdmin migration').log(seeded ? `No admin existed: ${seeded} (the oldest human user) is now an admin` : 'Seeding admin skipped: an admin exists or there is no human user');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_user_audit_log_target_user_id"`);
        await queryRunner.query(`DROP TABLE "user_audit_log"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_setup_tokens_token_hash"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_setup_tokens_user_id"`);
        await queryRunner.query(`DROP TABLE "user_setup_tokens"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "deactivated_by_id"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "deactivated_at"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_admin"`);
    }
}
