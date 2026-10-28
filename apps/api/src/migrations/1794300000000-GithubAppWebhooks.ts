import { MigrationInterface, QueryRunner } from "typeorm";

/** GitHub App installation status per repo and processed webhook deliveries. Additive only. */
export class GithubAppWebhooks1794300000000 implements MigrationInterface {
    name = 'GithubAppWebhooks1794300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "github_installations" ("full_name" character varying NOT NULL, "installed" boolean NOT NULL DEFAULT true, "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_github_installations" PRIMARY KEY ("full_name"))`);
        await queryRunner.query(`CREATE TABLE "webhook_deliveries" ("delivery_id" character varying NOT NULL, "received_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("delivery_id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
        await queryRunner.query(`DROP TABLE "github_installations"`);
    }
}
