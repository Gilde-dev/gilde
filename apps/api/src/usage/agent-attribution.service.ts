import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { AgentUsage } from '../otel/agent-usage.entity.js';
import { JobRun } from '../run/run.entity.js';

export interface AttributionResult {
    /** True when another pass was running and this call did nothing. */
    skipped: boolean;
    /** Quiet sessions with rows that were unassigned or time_window-assigned. */
    sessionsExamined: number;
    /** Sessions resolved by a unique exact `job_runs.session_id` match. */
    sessionsBySession: number;
    /** Sessions resolved by the single run fired in [T-10m, T]. */
    sessionsByTimeWindow: number;
    /** Sessions with two or more exact matches or two or more window candidates. */
    sessionsAmbiguous: number;
    /** Sessions with no exact match and no window candidate. */
    sessionsUnmatched: number;
    /** Previously unassigned rows that got a run. */
    rowsAttributed: number;
    /** time_window rows replaced by a unique exact match. */
    rowsUpgraded: number;
}

export const QUIET_DELAY_MS = 10 * 60_000;
export const START_WINDOW_MS = 10 * 60_000;
const SESSION_BATCH = 100;
const MAX_BATCHES_PER_PASS = 20;

export const emptyAttributionResult = (): AttributionResult => ({
    skipped: false, sessionsExamined: 0, sessionsBySession: 0, sessionsByTimeWindow: 0, sessionsAmbiguous: 0, sessionsUnmatched: 0, rowsAttributed: 0, rowsUpgraded: 0,
});

/**
 * Attributes stored Claude Code usage to Gilde runs, in a delayed pass (never at ingest, run lifecycle or read time).
 * Both the quiet delay and the start-time proximity are heuristics: assigned rows stay frozen, except that a unique
 * exact session-id match may later replace a `time_window` assignment. `finishedAt` is never consulted.
 */
@Injectable()
export class AgentAttributionService {
    private readonly logger = new Logger('AgentAttribution');
    private running = false;
    /** Replaced in tests; the pass reads it once. */
    clock: () => Date = () => new Date();

    constructor(
        @InjectRepository(AgentUsage) private readonly usage: Repository<AgentUsage>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
    ) { }

    @Cron(CronExpression.EVERY_5_MINUTES)
    async scheduled(): Promise<void> {
        try {
            await this.attribute();
        } catch (e) {
            this.logger.error(`Agent usage attribution failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** One bounded pass. A call that overlaps a running one returns immediately with `skipped: true`. */
    async attribute(): Promise<AttributionResult> {
        const result = emptyAttributionResult();
        if (this.running) return { ...result, skipped: true };
        this.running = true;
        try {
            const now = this.clock();
            const cutoff = new Date(now.getTime() - QUIET_DELAY_MS);
            let cursor = '';
            for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
                const sessions = await this.quietSessions(cutoff, cursor);
                for (const sessionId of sessions) {
                    try {
                        await this.attributeSession(sessionId, result);
                    } catch (e) {
                        this.logger.warn(`Attribution of a session failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                if (sessions.length < SESSION_BATCH) break;
                cursor = sessions[sessions.length - 1];
            }
            return result;
        } finally {
            this.running = false;
        }
    }

    /** Sessions whose latest event over ALL their rows is strictly before `cutoff` and which still have unassigned or time_window rows. */
    private async quietSessions(cutoff: Date, after: string): Promise<string[]> {
        const rows = await this.usage.createQueryBuilder('a')
            .select('a.sessionId', 'sessionId')
            .where('a.sessionId > :after', { after })
            .groupBy('a.sessionId')
            .having('MAX(a.eventAt) < :cutoff', { cutoff })
            .andHaving("SUM(CASE WHEN a.runId IS NULL OR a.attribution = 'time_window' THEN 1 ELSE 0 END) > 0")
            .orderBy('a.sessionId', 'ASC')
            .limit(SESSION_BATCH)
            .getRawMany<{ sessionId: string }>();
        return rows.map((r) => r.sessionId);
    }

    private async attributeSession(sessionId: string, result: AttributionResult): Promise<void> {
        result.sessionsExamined++;
        const newest = await this.usage.findOne({ where: { sessionId }, order: { eventAt: 'DESC' }, select: { eventAt: true } });
        const oldest = await this.usage.findOne({ where: { sessionId }, order: { eventAt: 'ASC' }, select: { eventAt: true } });
        if (!newest || !oldest) return;

        const exact = await this.runs.find({ where: { sessionId }, take: 2 });
        if (exact.length > 1) {
            result.sessionsAmbiguous++;
            return;
        }
        if (exact.length === 1) {
            const run = exact[0];
            const set = { runId: run.id, jobId: run.jobId, attribution: 'session' } as const;
            const base = 'session_id = :sessionId AND event_at <= :newest';
            const params = { sessionId, newest: newest.eventAt };
            const fresh = await this.usage.createQueryBuilder().update(AgentUsage).set(set).where(base, params).andWhere('run_id IS NULL AND attribution IS NULL').execute();
            const upgraded = await this.usage.createQueryBuilder().update(AgentUsage).set(set).where(base, params).andWhere("attribution = 'time_window'").execute();
            result.sessionsBySession++;
            result.rowsAttributed += fresh.affected ?? 0;
            result.rowsUpgraded += upgraded.affected ?? 0;
            return;
        }

        // No exact match: fall back to the start time, over the rows that are still unassigned only.
        const unassigned = await this.usage.count({ where: { sessionId, runId: IsNull() } });
        if (unassigned === 0) return;
        const t = oldest.eventAt;
        const candidates = await this.runs.createQueryBuilder('r')
            .where('r.firedAt IS NOT NULL AND r.firedAt >= :from AND r.firedAt <= :to', { from: new Date(t.getTime() - START_WINDOW_MS), to: t })
            .limit(2)
            .getMany();
        if (candidates.length === 0) {
            result.sessionsUnmatched++;
            return;
        }
        if (candidates.length > 1) {
            result.sessionsAmbiguous++;
            return;
        }
        const run = candidates[0];
        const res = await this.usage.createQueryBuilder().update(AgentUsage)
            .set({ runId: run.id, jobId: run.jobId, attribution: 'time_window' })
            .where('session_id = :sessionId AND event_at <= :newest', { sessionId, newest: newest.eventAt })
            .andWhere('run_id IS NULL AND attribution IS NULL')
            .execute();
        result.sessionsByTimeWindow++;
        result.rowsAttributed += res.affected ?? 0;
    }
}
