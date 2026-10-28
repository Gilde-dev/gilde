import { DataSource, EntityManager } from 'typeorm';

import type { McpConfig } from './mcp.config.js';
import { McpQuotaExceededError } from './mcp.errors.js';
import { McpUsageDay } from './mcp-usage-day.entity.js';

export type Clock = () => Date;

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface QuotaCounts {
    jobs: number;
    features: number;
}

/**
 * Durable per-user, per-UTC-day MCP creation allowance. `reserve` runs inside the transaction that creates the records:
 * it makes sure the day's row exists and then raises the counters with ONE conditional UPDATE (`... WHERE used + n <= limit`),
 * which takes the row lock on Postgres and is serialized by the database lock on SQLite. Over the limit it throws and the
 * caller's transaction rolls back, so a refused or failed creation consumes nothing and concurrent callers, other
 * processes and restarts cannot exceed the limits. There is no in-process counter.
 */
export class McpQuotaService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly limits: Pick<McpConfig, 'dailyJobLimit' | 'dailyFeatureLimit'>,
        private readonly clock: Clock = () => new Date(),
    ) { }

    private tail: Promise<unknown> = Promise.resolve();

    /**
     * SQLite has one connection, so overlapping TypeORM transactions on it fail ("cannot start a transaction within a
     * transaction"). Writers that open a transaction run one after the other there; Postgres runs them in parallel. This
     * only orders transactions: the limit itself is enforced by the conditional UPDATE in the database, not by this queue.
     */
    serialized<T>(fn: () => Promise<T>): Promise<T> {
        if (this.dataSource.options.type !== 'better-sqlite3') return fn();
        const run = this.tail.then(fn, fn);
        this.tail = run.catch(() => undefined);
        return run;
    }

    /** Runs `work` in one transaction after reserving `counts` for `userId`; anything thrown rolls the reservation back too. */
    withReservation<T>(userId: string, counts: Partial<QuotaCounts>, work: (m: EntityManager) => Promise<T>): Promise<T> {
        return this.serialized(() => this.dataSource.transaction(async (m) => {
            await this.reserve(m, userId, counts);
            return work(m);
        }));
    }

    /** Reserves `counts` for today (UTC) inside the caller's transaction, or throws McpQuotaExceededError. */
    async reserve(m: EntityManager, userId: string, counts: Partial<QuotaCounts>): Promise<void> {
        const jobs = counts.jobs ?? 0;
        const features = counts.features ?? 0;
        if (!Number.isSafeInteger(jobs) || !Number.isSafeInteger(features) || jobs < 0 || features < 0) throw new Error('Invalid quota reservation');
        // The limits are checked first so a disabled kind (0) is refused without touching the table.
        if (jobs > 0 && jobs > this.limits.dailyJobLimit) throw new McpQuotaExceededError('jobs', this.limits.dailyJobLimit);
        if (features > 0 && features > this.limits.dailyFeatureLimit) throw new McpQuotaExceededError('features', this.limits.dailyFeatureLimit);
        const day = utcDay(this.clock());
        await m.createQueryBuilder().insert().into(McpUsageDay)
            .values({ userId, day, jobsCreated: 0, featuresCreated: 0 })
            .orIgnore()
            .execute();
        // jobs/features are validated integers, so inlining them is safe; the limits are parameters.
        const res = await m.createQueryBuilder().update(McpUsageDay)
            .set({ jobsCreated: () => `"jobs_created" + ${jobs}`, featuresCreated: () => `"features_created" + ${features}` })
            .where('"user_id" = :userId AND "day" = :day', { userId, day })
            .andWhere(`"jobs_created" + ${jobs} <= :jobLimit`, { jobLimit: this.limits.dailyJobLimit })
            .andWhere(`"features_created" + ${features} <= :featureLimit`, { featureLimit: this.limits.dailyFeatureLimit })
            .execute();
        if (res.affected === 1) return;
        const row = await m.findOneBy(McpUsageDay, { userId, day });
        if (jobs > 0 && (row?.jobsCreated ?? 0) + jobs > this.limits.dailyJobLimit) throw new McpQuotaExceededError('jobs', this.limits.dailyJobLimit);
        throw new McpQuotaExceededError('features', this.limits.dailyFeatureLimit);
    }

    /** Today's usage of a user (for tests and diagnostics). */
    async usage(userId: string): Promise<QuotaCounts> {
        const row = await this.dataSource.manager.findOneBy(McpUsageDay, { userId, day: utcDay(this.clock()) });
        return { jobs: row?.jobsCreated ?? 0, features: row?.featuresCreated ?? 0 };
    }
}
