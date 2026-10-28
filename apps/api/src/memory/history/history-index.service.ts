import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';

import { MEMORY_INFRASTRUCTURE } from '../memory.tokens.js';
import type { MemoryInfrastructure } from '../memory.infrastructure.js';

import { UsageService } from '../../usage/usage.service.js';
import { HistoryEmbedder } from './history-embedder.js';
import { HistorySourceService } from './history-source.service.js';
import type { HistoryRunSummary, HistoryStatus } from './history.dto.js';
import { HistoryEntry, HistoryState, type HistoryPassStats } from './history.entity.js';
import { chunkId, historyKey, HISTORY_OPTIONS, SCAN_KINDS, type HistoryDocument, type HistoryOptions, type HistoryRecord, type ScanKind } from './history.types.js';

const STATE_ID = 'history';
const isoOrNull = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const emptyStats = (): HistoryPassStats => ({ indexed: 0, unchanged: 0, removed: 0, embeddedChunks: 0 });
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Keeps the history vector index in step with the source records. A pass walks every source kind in id order in bounded
 * batches, embeds only sources whose content hash changed, removes the chunks of sources that went away or stopped
 * being eligible, and persists its cursor after each batch, so a restart or a failure resumes without redoing or
 * skipping work. Passes never overlap: callers join the running one.
 */
@Injectable()
export class HistoryIndexService implements OnApplicationBootstrap {
    private readonly logger = new Logger('HistoryIndex');
    private readonly embedder: HistoryEmbedder;
    private inflight: Promise<HistoryRunSummary> | null = null;

    constructor(
        @Inject(MEMORY_INFRASTRUCTURE) private readonly infra: MemoryInfrastructure,
        @Inject(HISTORY_OPTIONS) private readonly options: HistoryOptions,
        private readonly source: HistorySourceService,
        @InjectRepository(HistoryEntry) private readonly entries: Repository<HistoryEntry>,
        @InjectRepository(HistoryState) private readonly states: Repository<HistoryState>,
        @Optional() private readonly usage?: UsageService,
    ) {
        this.embedder = new HistoryEmbedder(infra, options, usage);
    }

    /** One bounded run on startup (backfill resumes from the persisted cursor). Failures are logged, never thrown. */
    onApplicationBootstrap(): void {
        void this.scheduled();
    }

    @Cron(CronExpression.EVERY_MINUTE)
    async scheduled(): Promise<void> {
        try {
            const result = await this.reconcile();
            if (result.outcome === 'failed') this.logger.warn(`History reconcile failed: ${result.error}`);
        } catch (e) {
            this.logger.error(`History reconcile crashed: ${errorMessage(e)}`);
        }
    }

    /** Runs a bounded part of a pass: resumes the unfinished one, or starts a new one when the last is older than the freshness target. */
    reconcile(): Promise<HistoryRunSummary> {
        return (this.inflight ??= this.run(false).finally(() => { this.inflight = null; }));
    }

    /** Waits for a running pass, then drops all chunks and bookkeeping, and starts a fresh backfill (bounded; it resumes on the next ticks). */
    async rebuild(): Promise<HistoryRunSummary> {
        while (this.inflight) await this.inflight.catch(() => undefined);
        const run = this.run(true).finally(() => { this.inflight = null; });
        this.inflight = run;
        return run;
    }

    async status(): Promise<HistoryStatus> {
        const state = await this.states.findOne({ where: { id: STATE_ID } });
        return {
            enabled: this.options.enabled,
            embeddings: this.infra.embeddingsEnabled,
            reason: this.options.enabled ? this.infra.degradedReason : 'MEMORY_HISTORY_INDEX=off',
            indexName: this.infra.historyIndexName,
            indexedSources: await this.entries.count(),
            passInProgress: !!state?.passId,
            progress: { scanKind: state?.scanKind ?? null, phase: state?.passId ? state.phase : null, cursor: state?.cursor ?? null },
            passStartedAt: isoOrNull(state?.passStartedAt),
            lastCompletedAt: isoOrNull(state?.lastCompletedAt),
            lastError: state?.lastError ?? null,
            lastErrorAt: isoOrNull(state?.lastErrorAt),
            consecutiveFailures: state?.consecutiveFailures ?? 0,
            stats: state?.stats ?? null,
        };
    }

    private async run(rebuild: boolean): Promise<HistoryRunSummary> {
        const summary: HistoryRunSummary = { outcome: 'idle', batches: 0, stats: emptyStats() };
        if (!this.options.enabled || !this.infra.embeddingsEnabled) return { ...summary, outcome: 'disabled' };
        let state = (await this.states.findOne({ where: { id: STATE_ID } })) ?? this.states.create({ id: STATE_ID, phase: 'scan', consecutiveFailures: 0 });
        try {
            if (rebuild || (state.indexSignature && state.indexSignature !== this.infra.embeddingSignature)) {
                if (!rebuild) this.logger.warn(`Embedding model or dimension changed (${state.indexSignature} -> ${this.infra.embeddingSignature}); rebuilding the history index`);
                state = await this.reset(state);
            } else {
                await this.infra.ensureHistoryIndex();
            }
            if (!state.passId) {
                const due = !state.lastCompletedAt || Date.now() - state.lastCompletedAt.getTime() >= this.options.freshnessMs;
                if (!due) return summary;
                state = await this.states.save(Object.assign(state, {
                    passId: randomUUID(), scanKind: SCAN_KINDS[0], phase: 'scan', cursor: null, passStartedAt: new Date(), stats: emptyStats(), indexSignature: this.infra.embeddingSignature,
                }));
            }
            while (state.passId && summary.batches < this.options.maxBatchesPerRun) {
                const stats = state.stats ?? emptyStats();
                const delta = await this.step(state);
                for (const key of Object.keys(stats) as (keyof HistoryPassStats)[]) {
                    stats[key] += delta[key];
                    summary.stats[key] += delta[key];
                }
                state.stats = stats;
                summary.batches++;
                state = await this.states.save(state);
            }
            summary.outcome = state.passId ? 'partial' : 'complete';
            if (!state.passId) this.logger.log(`History pass complete: ${JSON.stringify(state.stats)}`);
            return summary;
        } catch (e) {
            // The cursor was only saved after the last good batch, so the next run retries from there.
            await this.states.save(Object.assign(state, { lastError: errorMessage(e).slice(0, 1000), lastErrorAt: new Date(), consecutiveFailures: (state.consecutiveFailures ?? 0) + 1 })).catch(() => undefined);
            return { ...summary, outcome: 'failed', error: errorMessage(e) };
        }
    }

    /** Clears the vectors and all bookkeeping. */
    private async reset(state: HistoryState): Promise<HistoryState> {
        await this.infra.recreateHistoryIndex();
        await this.entries.clear();
        return this.states.save(Object.assign(state, {
            passId: null, scanKind: null, phase: 'scan', cursor: null, passStartedAt: null, lastCompletedAt: null,
            indexSignature: this.infra.embeddingSignature, lastError: null, lastErrorAt: null, consecutiveFailures: 0, stats: null,
        }));
    }

    /** Does one batch of the current phase and advances the persisted position (the caller saves `state`). */
    private async step(state: HistoryState): Promise<HistoryPassStats> {
        const kind = state.scanKind as ScanKind;
        const passId = state.passId!;
        const delta = emptyStats();
        if (state.phase === 'scan') {
            const page = await this.source.page(kind, state.cursor, this.options.batchSize);
            if (page.length) {
                await this.syncBatch(kind, passId, page, delta);
                state.cursor = page[page.length - 1].sourceId;
            }
            if (page.length < this.options.batchSize) {
                state.phase = 'prune';
                state.cursor = null;
            }
        } else {
            const stale = await this.entries.find({ where: [{ scanKind: kind, seenPass: Not(passId) }, { scanKind: kind, seenPass: IsNull() }], take: this.options.batchSize });
            if (stale.length) await this.remove(stale, delta);
            if (stale.length < this.options.batchSize) {
                const next = SCAN_KINDS[SCAN_KINDS.indexOf(kind) + 1];
                if (next) {
                    state.scanKind = next;
                    state.phase = 'scan';
                    state.cursor = null;
                } else {
                    Object.assign(state, { passId: null, scanKind: null, phase: 'scan', cursor: null, lastCompletedAt: new Date(), lastError: null, lastErrorAt: null, consecutiveFailures: 0 });
                }
            }
        }
        return delta;
    }

    private async syncBatch(kind: ScanKind, passId: string, page: HistoryRecord[], delta: HistoryPassStats): Promise<void> {
        const keyed = page.filter((r) => r.type);
        const existing = new Map((await this.entries.find({ where: { id: In(keyed.map((r) => historyKey(r.type!, r.sourceId))) } })).map((e) => [e.id, e]));
        const ineligible = keyed.filter((r) => !r.doc && existing.has(historyKey(r.type!, r.sourceId)));
        if (ineligible.length) await this.remove(ineligible.map((r) => existing.get(historyKey(r.type!, r.sourceId))!), delta);

        const unchanged: string[] = [];
        const changed: HistoryDocument[] = [];
        for (const record of keyed) {
            const doc = record.doc;
            if (!doc) continue;
            const entry = existing.get(historyKey(doc.type, doc.sourceId));
            if (entry && entry.contentHash === doc.hash && entry.chunkCount === doc.chunks.length) unchanged.push(entry.id);
            else changed.push(doc);
        }
        if (unchanged.length) await this.entries.update({ id: In(unchanged) }, { seenPass: passId });
        delta.unchanged += unchanged.length;

        // Embedding requests are sequential and bounded; a source is committed once its own chunks are stored.
        let pending: HistoryDocument[] = [];
        let pendingChunks = 0;
        const flush = async () => {
            if (!pending.length) return;
            const vectors = await this.embedder.embed(pending.flatMap((d) => d.chunks));
            delta.embeddedChunks += vectors.length;
            let offset = 0;
            for (const doc of pending) {
                await this.store(kind, passId, doc, vectors.slice(offset, offset + doc.chunks.length), existing.get(historyKey(doc.type, doc.sourceId)));
                offset += doc.chunks.length;
                delta.indexed++;
            }
            pending = [];
            pendingChunks = 0;
        };
        for (const doc of changed) {
            if (pending.length && pendingChunks + doc.chunks.length > this.options.embedBatchSize) await flush();
            pending.push(doc);
            pendingChunks += doc.chunks.length;
        }
        await flush();
    }

    private async store(kind: ScanKind, passId: string, doc: HistoryDocument, vectors: number[][], previous: HistoryEntry | undefined): Promise<void> {
        const indexName = this.infra.historyIndexName;
        await this.infra.historyVector.upsert({
            indexName,
            vectors,
            ids: doc.chunks.map((_, i) => chunkId(doc.type, doc.sourceId, i)),
            metadata: doc.chunks.map((text, i) => ({
                sourceType: doc.type, sourceId: doc.sourceId, projectId: doc.projectId, repoId: doc.repoId,
                chunkIndex: i, contentHash: doc.hash, text,
            })),
        });
        if (previous && previous.chunkCount > doc.chunks.length) {
            const extra = Array.from({ length: previous.chunkCount - doc.chunks.length }, (_, i) => chunkId(doc.type, doc.sourceId, doc.chunks.length + i));
            await this.infra.historyVector.deleteVectors({ indexName, ids: extra });
        }
        await this.entries.save(this.entries.create({
            id: historyKey(doc.type, doc.sourceId), scanKind: kind, sourceType: doc.type, sourceId: doc.sourceId, projectId: doc.projectId,
            contentHash: doc.hash, chunkCount: doc.chunks.length, seenPass: passId,
        }));
    }

    private async remove(entries: HistoryEntry[], delta: HistoryPassStats): Promise<void> {
        const ids = entries.flatMap((e) => Array.from({ length: e.chunkCount }, (_, i) => `${e.id}:${i}`));
        if (ids.length) await this.infra.historyVector.deleteVectors({ indexName: this.infra.historyIndexName, ids });
        await this.entries.delete({ id: In(entries.map((e) => e.id)) });
        delta.removed += entries.length;
    }
}
