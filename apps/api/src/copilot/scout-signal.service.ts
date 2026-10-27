import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { Mastra } from '@mastra/core/mastra';
import type { NotificationsStorage } from '@mastra/core/storage';
import { Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';
import { FEATURE_STATUSES } from '../feature/feature-state.js';
import type { ScoutEvent } from '../scout-signal/scout-signal.events.js';
import type { ScoutEventSink } from '../scout-signal/scout-signal.publisher.js';
import { envelopeFor, eventRepoId, SCOUT_SIGNAL_SOURCE, type ScoutEnvelope } from './scout-signal.envelope.js';
import { ScoutSignalReceipt } from './scout-signal-receipt.entity.js';
import { nextSummaryAt, type ScoutWakeBudgetService } from './scout-wake-budget.service.js';
import { SCOUT_AGENT_ID } from './verkenner.config.js';
import type { ScoutThreads } from './verkenner.threads.js';

/** At most this many parked job ids and open feature ids go into the board state; the status counts stay exact. */
export const BOARD_LIST_LIMIT = 20;
export const BOARD_STATE_ID = 'board';

export interface ScoutSignalDeps {
    mastra: Mastra;
    threads: ScoutThreads;
    receipts: Repository<ScoutSignalReceipt>;
    budget: ScoutWakeBudgetService;
    jobs: { statusSnapshot(projectId: string, parkedLimit?: number): Promise<{ counts: Record<string, number>; parkedIds: string[] }> };
    features: { list(projectId: string, q: { status?: (typeof FEATURE_STATUSES)[number] }): Promise<Array<{ id: string; status: string }>> };
    repos: { getById(id: string): Promise<{ fullName: string }> };
    /** The native notification store; used to see whether backlog waits. */
    inbox: () => Promise<NotificationsStorage | undefined>;
    summaryHourUtc: number;
}

/**
 * Publishes the six factory events into the scout's native notification inbox. Everything here is best effort: a
 * failure is logged and never reaches the caller. Wakes are claimed from the durable per-project daily budget before the
 * signal is handed to Mastra; medium, low and over-budget events stay pending for the daily native summary.
 */
export class ScoutSignalService {
    private readonly logger = new Logger('Verkenner');
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly summaryQueues = new Map<string, Promise<unknown>>();

    constructor(private readonly deps: ScoutSignalDeps) { }

    /** The sink registered with the publisher. */
    readonly sink: ScoutEventSink = (projectId, event) => this.publish(projectId, event);

    async publish(projectId: string, event: ScoutEvent): Promise<void> {
        try {
            const repoId = eventRepoId(event);
            let repo: string | null = null;
            if (repoId) repo = await this.deps.repos.getById(repoId).then((r) => r.fullName).catch(() => null);
            await this.serial(this.queues, projectId, () => this.deliver(projectId, envelopeFor(projectId, event, repo)));
        } catch (error) {
            this.logger.warn(`Scout signal ${event.type} for project ${projectId} was not delivered: ${message(error)}`);
        }
    }

    /** Runs `task` after every earlier task for the same key, so one project's decisions never overlap. */
    serial<T>(map: Map<string, Promise<unknown>>, key: string, task: () => Promise<T>): Promise<T> {
        const previous = map.get(key) ?? Promise.resolve();
        const run = previous.then(task, task);
        const tail = run.catch(() => undefined);
        map.set(key, tail);
        void tail.then(() => { if (map.get(key) === tail) map.delete(key); });
        return run;
    }

    private async deliver(projectId: string, envelope: ScoutEnvelope): Promise<void> {
        const { budget } = this.deps;
        try {
            await this.deps.receipts.insert({ projectId, dedupeKey: envelope.dedupeKey });
        } catch (error) {
            if (isUniqueViolation(error)) return; // already published: redelivery, retry or restart
            throw error;
        }

        let claim: { at: Date } | null = null;
        try {
            const target = await this.deps.threads.ensureThread(projectId);
            if (envelope.priority === 'high') {
                claim = await budget.claimWake(projectId, { reserveSummary: await this.hasBacklog(target.threadId) });
                if (claim) {
                    try {
                        await this.sendBoardState(projectId);
                    } catch (error) {
                        this.logger.warn(`Board state for project ${projectId} was not sent before the wake: ${message(error)}`);
                    }
                }
            }
            const { priority, ...rest } = envelope;
            const agent = this.deps.mastra.getAgent(SCOUT_AGENT_ID);
            const claimedAt = claim?.at;
            // From here on a wake may have happened, whatever the outcome: the claim is not given back.
            claim = null;
            const result = await agent.sendNotificationSignal(
                { ...rest, priority, metadata: { wake: claimedAt ? 'granted' : 'deferred' } },
                target,
            );
            if (claimedAt) await budget.recordWake(projectId, claimedAt);
            // The wake runs on its own; its failures belong to Mastra's delivery bookkeeping, not to the recording caller.
            void Promise.resolve(result.accepted).catch((error: unknown) => this.logger.warn(`Delivery of ${envelope.kind} failed: ${message(error)}`));
        } catch (error) {
            // Not sent: let a redelivery try again. A wake claimed for a signal that never reached Mastra is given back.
            if (claim) await budget.refundWake(projectId, claim.at).catch(() => undefined);
            await this.deps.receipts.delete({ projectId, dedupeKey: envelope.dedupeKey }).catch(() => undefined);
            throw error;
        }
    }

    /** Pending records whose summary moment has come. */
    private async dueRecords(projectId: string) {
        const inbox = await this.deps.inbox();
        if (!inbox) return [];
        const now = this.deps.budget.now().getTime();
        const pending = await inbox.listNotifications({ threadId: this.deps.threads.threadId(projectId), status: 'pending', source: SCOUT_SIGNAL_SOURCE });
        return pending.filter((r) => r.summaryAt && r.summaryAt.getTime() <= now);
    }

    /** True while records wait for a summary that will wake the agent (anything above low priority). */
    private async hasBacklog(threadId: string): Promise<boolean> {
        const inbox = await this.deps.inbox();
        if (!inbox) return false;
        const pending = await inbox.listNotifications({ threadId, status: 'pending', source: SCOUT_SIGNAL_SOURCE });
        return pending.some((r) => r.priority !== 'low' && r.metadata?.wake !== 'granted');
    }

    /**
     * Sends the project's board (exact status counts, parked job ids, open feature ids) as a native state signal. The
     * cacheKey is derived from the content, so an unchanged board is skipped by Mastra. Called before an actual wake only.
     */
    async sendBoardState(projectId: string): Promise<{ sent: boolean }> {
        const target = await this.deps.threads.ensureThread(projectId);
        const [{ counts, parkedIds }, features] = await Promise.all([
            this.deps.jobs.statusSnapshot(projectId, BOARD_LIST_LIMIT),
            this.deps.features.list(projectId, {}),
        ]);
        const open = features.filter((f) => f.status === 'draft' || f.status === 'active');
        const value = {
            projectId,
            jobCounts: counts,
            parkedJobIds: parkedIds,
            openFeatures: open.slice(0, BOARD_LIST_LIMIT).map((f) => ({ id: f.id, status: f.status })),
            openFeatureCount: open.length,
        };
        const cacheKey = `board:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`;
        const contents = [
            `Board of project ${projectId}.`,
            `Jobs by status: ${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(', ')}.`,
            `Parked job ids${parkedIds.length >= BOARD_LIST_LIMIT ? ` (first ${BOARD_LIST_LIMIT})` : ''}: ${parkedIds.join(', ') || 'none'}.`,
            `Open features (${open.length}${open.length > BOARD_LIST_LIMIT ? `, first ${BOARD_LIST_LIMIT} listed` : ''}): ${value.openFeatures.map((f) => `${f.id} ${f.status}`).join(', ') || 'none'}.`,
        ].join('\n');
        const agent = this.deps.mastra.getAgent(SCOUT_AGENT_ID);
        const result = await agent.sendStateSignal(
            { id: BOARD_STATE_ID, mode: 'snapshot', cacheKey, contents, value },
            { ...target, ifIdle: { behavior: 'persist' } },
        );
        if (result.skipped) return { sent: false };
        await result.persisted;
        return { sent: true };
    }

    /**
     * Dispatch-time gate for the native summary: claims the day's summary (one wake of the daily cap) and sends the board
     * state before it. False keeps the backlog pending. Serialized per project, separately from publishing.
     */
    allowSummary(projectId: string): Promise<boolean> {
        return this.serial(this.summaryQueues, projectId, async () => {
            // Mastra summarizes every due pending record of the thread; low-only summaries are persisted, not woken.
            const due = await this.dueRecords(projectId);
            if (due.length === 0) return false; // never an empty summary
            const claim = await this.deps.budget.claimSummary(projectId, due.some((r) => r.priority !== 'low'));
            if (claim === 'claimed') {
                try {
                    await this.sendBoardState(projectId);
                } catch (error) {
                    this.logger.warn(`Board state for project ${projectId} was not sent before the summary: ${message(error)}`);
                }
            }
            return claim !== 'denied';
        });
    }

    /** First summary moment after `now` for the configured UTC hour. */
    summaryAt(now: Date = this.deps.budget.now()): Date {
        return nextSummaryAt(now, this.deps.summaryHourUtc);
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
