import { MigrationInterface, QueryRunner } from "typeorm";

/** How an `agent_usage` row was attributed to a run: `session`, `time_window` or null. */
export class AgentUsageAttribution1793200000000 implements MigrationInterface {
    name = 'AgentUsageAttribution1793200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "agent_usage" ADD "attribution" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "agent_usage" DROP COLUMN "attribution"`);
    }
}
