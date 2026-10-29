import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';

import { agentLogRetentionDays } from './agent-run.config.js';
import { AgentRun } from './agent-run.entity.js';
import { AgentToolCall } from './agent-tool-call.entity.js';

const DAY_MS = 86_400_000;
const BATCH = 500;
/** A run that never reported an end (a crash, an error hook without context) is closed after this long. */
const STALE_MS = 30 * 60_000;

/** Retention of the run log, and the closing of runs that never ended. */
@Injectable()
export class AgentRunCleanupService {
    private readonly logger = new Logger('AgentRuns');

    constructor(
        @InjectRepository(AgentRun) private readonly runs: Repository<AgentRun>,
        @InjectRepository(AgentToolCall) private readonly toolCalls: Repository<AgentToolCall>,
    ) { }

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async scheduled(): Promise<void> {
        try {
            const removed = await this.cleanup();
            if (removed > 0) this.logger.log(`Run log retention removed ${removed} runs`);
        } catch (error) {
            this.logger.warn(`Run log retention failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @Cron(CronExpression.EVERY_HOUR)
    async sweep(): Promise<void> {
        try {
            await this.closeStale();
        } catch (error) {
            this.logger.warn(`Closing stale runs failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Deletes runs that started before the retention window, with their tool calls. Returns the number of runs removed. */
    async cleanup(now: Date = new Date()): Promise<number> {
        const cutoff = new Date(now.getTime() - agentLogRetentionDays() * DAY_MS);
        let removed = 0;
        for (;;) {
            const old = await this.runs.find({ select: { id: true }, where: { startedAt: LessThan(cutoff) }, take: BATCH });
            if (old.length === 0) return removed;
            const ids = old.map((r) => r.id);
            await this.toolCalls.delete({ runId: In(ids) });
            await this.runs.delete({ id: In(ids) });
            removed += ids.length;
        }
    }

    /** Ends runs of the unattended and chat agents that are still open long after they could have run. Coding-agent runs end with their job run. */
    async closeStale(now: Date = new Date()): Promise<number> {
        const res = await this.runs.update(
            { endedAt: IsNull(), agentId: Not('coding'), startedAt: LessThan(new Date(now.getTime() - STALE_MS)) },
            { endedAt: now, outcome: 'error', reason: 'The run did not report an end' },
        );
        return res.affected ?? 0;
    }
}
