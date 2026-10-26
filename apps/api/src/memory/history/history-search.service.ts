import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { MemoryInfrastructure } from '../memory.infrastructure.js';
import { MEMORY_INFRASTRUCTURE } from '../memory.tokens.js';

import { UsageService } from '../../usage/usage.service.js';
import { HistoryEmbedder } from './history-embedder.js';
import { HistorySourceService } from './history-source.service.js';
import {
    HISTORY_DEFAULT_TOP_K, HISTORY_MAX_EXCERPT_CHARS, HISTORY_MAX_QUERY_CHARS, HISTORY_MAX_TOP_K,
    type HistoryHitDto, type HistoryLessonHitDto, type HistoryLessonResultDto, type HistorySearchInput, type HistorySearchResultDto,
} from './history.dto.js';
import { HistoryState } from './history.entity.js';
import { historyKey, HISTORY_OPTIONS, type HistoryOptions, type HistorySourceType } from './history.types.js';

const LESSON_TEXT_CHARS = 1000;
const OVERFETCH = 4;

type VectorFilter = Record<string, unknown>;
interface RawHit { type: HistorySourceType; sourceId: string; hash: string; score: number; text: string }

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Searches the shared factory history. Vectors are restricted by project (and repo, type) before retrieval, and every
 * hit is revalidated against the current source record before it is returned, so deleted, edited, revoked or
 * requeued sources never come back while the index catches up. Personal co-pilot memory is a different store and is
 * never searched here.
 */
@Injectable()
export class HistorySearchService {
    private readonly embedder: HistoryEmbedder;

    constructor(
        @Inject(MEMORY_INFRASTRUCTURE) private readonly infra: MemoryInfrastructure,
        @Inject(HISTORY_OPTIONS) private readonly options: HistoryOptions,
        private readonly source: HistorySourceService,
        @InjectRepository(HistoryState) private readonly states: Repository<HistoryState>,
        @Optional() private readonly usage?: UsageService,
    ) {
        this.embedder = new HistoryEmbedder(infra, options, usage);
    }

    /** Throws NotFound/BadRequest for an unknown project or repo, or a repo outside the project. Retrieval problems return `unavailable`. */
    async search(input: HistorySearchInput): Promise<HistorySearchResultDto> {
        await this.source.assertScope(input.projectId, input.repoId);
        const topK = Math.min(input.topK ?? HISTORY_DEFAULT_TOP_K, HISTORY_MAX_TOP_K);
        const clauses: VectorFilter[] = [{ projectId: input.projectId }];
        if (input.types) clauses.push({ sourceType: { $in: input.types } });
        // A repo search also covers the project's project-wide lessons.
        if (input.repoId) clauses.push({ $or: [{ repoId: input.repoId }, { $and: [{ sourceType: 'lesson' }, { repoId: '' }] }] });
        const raw = await this.retrieve(input.query, { $and: clauses }, topK * OVERFETCH);
        if (!Array.isArray(raw)) return raw;

        const current = await this.source.load(raw);
        const best = new Map<string, HistoryHitDto>();
        let suppressed = 0;
        for (const hit of raw) {
            const key = historyKey(hit.type, hit.sourceId);
            const record = current.get(key);
            const doc = record?.doc;
            const inScope = doc && doc.projectId === input.projectId
                && (!input.repoId || doc.repoId === input.repoId || (doc.type === 'lesson' && doc.repoId === ''))
                && (!input.types || input.types.includes(doc.type));
            // The chunk text must still be the current text of its source.
            if (!record || !doc || !inScope || doc.hash !== hit.hash) { suppressed++; continue; }
            if ((best.get(key)?.score ?? -1) >= hit.score) continue;
            const p = record.provenance;
            best.set(key, {
                score: hit.score, sourceType: doc.type, sourceId: doc.sourceId, projectId: doc.projectId, repoId: p.repoId, repoFullName: p.repoFullName,
                jobId: p.jobId, jobTitle: p.jobTitle, runId: p.runId, attempt: p.attempt, outcome: p.outcome, status: p.status, prUrl: p.prUrl, url: p.url,
                excerpt: hit.text.slice(0, HISTORY_MAX_EXCERPT_CHARS),
            });
        }
        const results = [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
        const state = await this.states.findOne({ where: { id: 'history' } }).catch(() => null);
        return { status: 'ok', results, indexComplete: !!state?.lastCompletedAt, suppressed };
    }

    /**
     * Approved, applying and applied lessons relevant to a query, for dispatch: only the project's lessons that are
     * project-wide or target `repoId`. Never returns reviews, retros or anything personal.
     */
    async searchLessons(input: { projectId: string; repoId: string; query: string; topK?: number; minScore?: number }): Promise<HistoryLessonResultDto> {
        await this.source.assertScope(input.projectId, input.repoId);
        const topK = Math.min(input.topK ?? HISTORY_DEFAULT_TOP_K, HISTORY_MAX_TOP_K);
        const filter = { $and: [{ projectId: input.projectId }, { sourceType: 'lesson' }, { $or: [{ repoId: '' }, { repoId: input.repoId }] }] };
        const raw = await this.retrieve(input.query, filter, topK * OVERFETCH);
        if (!Array.isArray(raw)) return { status: 'unavailable', reason: raw.reason, lessons: [] };

        const current = await this.source.load(raw);
        const seen = new Set<string>();
        const lessons: HistoryLessonHitDto[] = [];
        for (const hit of raw) {
            const record = current.get(historyKey(hit.type, hit.sourceId));
            const doc = record?.doc;
            if (!record || !doc || doc.type !== 'lesson' || seen.has(doc.sourceId)) continue;
            if (doc.projectId !== input.projectId || (doc.repoId !== '' && doc.repoId !== input.repoId) || doc.hash !== hit.hash) continue;
            if (input.minScore !== undefined && hit.score < input.minScore) continue;
            seen.add(doc.sourceId);
            lessons.push({
                lessonId: doc.sourceId, projectId: doc.projectId, targetRepoId: record.provenance.repoId, status: record.provenance.status ?? 'approved',
                score: hit.score, text: (record.provenance.lessonText ?? hit.text).slice(0, LESSON_TEXT_CHARS),
            });
        }
        return { status: 'ok', lessons: lessons.sort((a, b) => b.score - a.score).slice(0, topK) };
    }

    /** Embeds the query and queries the vector store within the hard timeout; any failure becomes `unavailable`. */
    private async retrieve(query: string, filter: VectorFilter, topK: number): Promise<RawHit[] | { status: 'unavailable'; reason: string; results: [] }> {
        if (!this.options.enabled) return unavailable('History search is switched off (MEMORY_HISTORY_INDEX=off)');
        if (!this.infra.embeddingsEnabled) return unavailable(`History search needs embeddings: ${this.infra.degradedReason}`);
        let timer: NodeJS.Timeout | undefined;
        try {
            const work = (async (): Promise<RawHit[]> => {
                const [queryVector] = await this.embedder.embed([query.slice(0, HISTORY_MAX_QUERY_CHARS)]);
                await this.infra.ensureHistoryIndex();
                const hits = await this.infra.historyVector.query({ indexName: this.infra.historyIndexName, queryVector, topK, filter: filter as never });
                return hits.flatMap((h) => {
                    const m = h.metadata ?? {};
                    return typeof m.sourceType === 'string' && typeof m.sourceId === 'string'
                        ? [{ type: m.sourceType as HistorySourceType, sourceId: m.sourceId, hash: String(m.contentHash ?? ''), score: h.score, text: String(m.text ?? '') }]
                        : [];
                });
            })();
            work.catch(() => undefined);
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${this.options.searchTimeoutMs} ms`)), this.options.searchTimeoutMs); });
            return await Promise.race([work, timeout]);
        } catch (e) {
            return unavailable(`History search failed: ${errorMessage(e)}`);
        } finally {
            clearTimeout(timer);
        }
    }
}

function unavailable(reason: string) {
    return { status: 'unavailable' as const, reason, results: [] as [] };
}
