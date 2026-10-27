import { Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';
import { ScoutWakeDay } from './scout-wake-day.entity.js';

/** Injectable clock so schedules and budgets are testable without real time. */
export type Clock = () => Date;

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The first summary moment strictly after `now`: today's `hour`:00 UTC when that is still ahead, else tomorrow's.
 * Used as the native `summaryAt`, so records that arrive after the day's summary wait for the next day's.
 */
export function nextSummaryAt(now: Date, hour: number): Date {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
    return new Date(today > now.getTime() ? today : today + 24 * 3_600_000);
}

/** Two summary-record dispatches within this window belong to the same claimed summary (one dispatch pass). */
export const SUMMARY_PASS_WINDOW_MS = 10 * 60_000;

export type SummaryClaim = 'claimed' | 'already' | 'denied';

/**
 * Durable per-project, per-UTC-day wake budget. Every actual wake (an immediate high wake or the daily summary) is one
 * conditional `UPDATE ... WHERE wakes_used < cap`, so concurrent calls, several processes and restarts cannot exceed
 * `maxWakesPerDay`. The summary is claimed at most once per day. Claimed wakes are never refunded after the signal was
 * handed to Mastra, because an ambiguous failure may still have woken the agent.
 */
export class ScoutWakeBudgetService {
    constructor(
        private readonly days: Repository<ScoutWakeDay>,
        private readonly settings: { maxWakesPerDay: number; summaryHourUtc: number },
        private readonly clock: Clock = () => new Date(),
    ) { }

    now(): Date {
        return this.clock();
    }

    private async ensureDay(projectId: string, day: string): Promise<void> {
        const existing = await this.days.findOneBy({ projectId, day });
        if (existing) return;
        try {
            await this.days.insert({ projectId, day, wakesUsed: 0, summaryClaimedAt: null, lastWakeAt: null });
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
        }
    }

    /**
     * Claims one immediate wake. While backlog waits and today's summary is not claimed yet, one slot stays reserved for it.
     * Returns null when the day's capacity (minus the reserve) is spent: the caller keeps the event pending.
     */
    async claimWake(projectId: string, options: { reserveSummary: boolean }): Promise<{ at: Date } | null> {
        const now = this.clock();
        const day = utcDay(now);
        await this.ensureDay(projectId, day);
        const row = await this.days.findOneByOrFail({ projectId, day });
        const limit = this.settings.maxWakesPerDay - (options.reserveSummary && !row.summaryClaimedAt ? 1 : 0);
        const res = await this.days.createQueryBuilder().update(ScoutWakeDay)
            .set({ wakesUsed: () => '"wakes_used" + 1' })
            .where('"project_id" = :projectId AND "day" = :day AND "wakes_used" < :limit', { projectId, day, limit })
            .execute();
        return res.affected === 1 ? { at: now } : null;
    }

    /** Gives back a wake claimed for a signal that was provably never handed to Mastra. */
    async refundWake(projectId: string, claimedAt: Date): Promise<void> {
        await this.days.createQueryBuilder().update(ScoutWakeDay)
            .set({ wakesUsed: () => '"wakes_used" - 1' })
            .where('"project_id" = :projectId AND "day" = :day AND "wakes_used" > 0', { projectId, day: utcDay(claimedAt) })
            .execute();
    }

    /** Marks the actual time of the wake once Mastra accepted the signal. */
    async recordWake(projectId: string, at: Date): Promise<void> {
        await this.days.update({ projectId, day: utcDay(at) }, { lastWakeAt: at });
    }

    /**
     * Claims the day's summary at dispatch time: allowed from the summary hour on and once per day. A summary that wakes the
     * agent (`wake`) also takes one wake of the daily cap and is denied when none is left; a summary of low events only is
     * persisted by Mastra without waking, so it costs no wake. `already` means another record of the same dispatch pass
     * claimed it moments ago.
     */
    async claimSummary(projectId: string, wake = true): Promise<SummaryClaim> {
        const now = this.clock();
        const day = utcDay(now);
        await this.ensureDay(projectId, day);
        const row = await this.days.findOneByOrFail({ projectId, day });
        if (row.summaryClaimedAt) {
            return now.getTime() - row.summaryClaimedAt.getTime() < SUMMARY_PASS_WINDOW_MS ? 'already' : 'denied';
        }
        if (now.getUTCHours() < this.settings.summaryHourUtc) return 'denied';
        const qb = this.days.createQueryBuilder().update(ScoutWakeDay)
            .set(wake ? { wakesUsed: () => '"wakes_used" + 1', summaryClaimedAt: now, lastWakeAt: now } : { summaryClaimedAt: now })
            .where('"project_id" = :projectId AND "day" = :day AND "summary_claimed_at" IS NULL', { projectId, day });
        if (wake) qb.andWhere('"wakes_used" < :cap', { cap: this.settings.maxWakesPerDay });
        return (await qb.execute()).affected === 1 ? 'claimed' : 'denied';
    }
}
