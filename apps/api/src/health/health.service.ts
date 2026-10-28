import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { HealthResponseDto } from "./health.dto.js";

type CheckStatus = 'up' | 'down';

@Injectable()
export class HealthService {

    constructor(
        private readonly dataSource: DataSource
    ) { }

    async getHealth(): Promise<HealthResponseDto> {
        const database = await this.checkDatabase();
        const status: CheckStatus = database.status;
        const health = { status, checks: { database } };

        if (status === 'down') {
            throw new ServiceUnavailableException(health);
        }

        return health;
    }

    private async checkDatabase(): Promise<{ status: CheckStatus; error?: string }> {
        try {
            if (!this.dataSource.isInitialized) {
                return { status: 'down', error: 'Data source not initialized' };
            }
            await this.dataSource.query('SELECT 1');
            return { status: 'up' };
        } catch (err) {
            return { status: 'down', error: err instanceof Error ? err.message : String(err) };
        }
    }
}
