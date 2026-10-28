import { createHash } from 'node:crypto';

import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Job } from '../job/job.entity.js';
import { HistoryEmbedder } from '../memory/history/history-embedder.js';
import { historyOptions } from '../memory/history/history.types.js';
import type { MemoryInfrastructure } from '../memory/memory.infrastructure.js';
import { MEMORY_INFRASTRUCTURE } from '../memory/memory.tokens.js';
import { ProjectService } from '../project/project.service.js';
import { UsageService } from '../usage/usage.service.js';
import { LESSON_PATTERN_MIN_SIZE, type LessonPatternDto, type LessonPatternsResponseDto, type ListLessonPatternsQuery } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonEmbedding } from './lesson-embedding.entity.js';
import { lessonPatternSimilarity } from './lesson-pattern.config.js';
import { cosine, jaccard, singleLinkGroups, textTokens, TEXT_JACCARD_THRESHOLD } from './lesson-pattern.grouping.js';
import { LessonSource } from './lesson-source.entity.js';
import type { LessonStatus } from './lesson-state.js';

/** Most recent lessons considered per project, so a pairwise comparison stays bounded. */
const MAX_LESSONS = 1000;
const GROUPED: readonly LessonStatus[] = ['candidate', 'approved'];
const COVERING: readonly LessonStatus[] = ['applying', 'applied'];
const MAX_COVERED = 3;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Groups a project's candidate and approved lessons into recurring patterns. Read-only and deterministic: it makes no
 * chat-model call, never changes a lesson, and uses embeddings only when the memory infrastructure has them.
 */
@Injectable()
export class LessonPatternService {
    private readonly embedder: HistoryEmbedder;

    constructor(
        @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
        @InjectRepository(LessonSource) private readonly sources: Repository<LessonSource>,
        @InjectRepository(LessonEmbedding) private readonly embeddings: Repository<LessonEmbedding>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @Inject(MEMORY_INFRASTRUCTURE) private readonly infra: MemoryInfrastructure,
        private readonly projects: ProjectService,
        private readonly mapper: LessonMapper,
        @Optional() usage?: UsageService,
    ) {
        this.embedder = new HistoryEmbedder(infra, historyOptions(), usage);
    }

    async list(projectId: string, q: ListLessonPatternsQuery = {}): Promise<LessonPatternsResponseDto> {
        await this.projects.getById(projectId);
        const minSize = q.minSize ?? LESSON_PATTERN_MIN_SIZE;
        let embeddingThreshold: number;
        try {
            embeddingThreshold = lessonPatternSimilarity();
        } catch (e) {
            throw new ServiceUnavailableException(e instanceof Error ? e.message : String(e));
        }

        const all = (await this.lessons.find({
            where: { projectId, status: In([...GROUPED, ...COVERING]) },
            order: { createdAt: 'DESC', id: 'ASC' },
            take: MAX_LESSONS,
        })).sort(byId);
        const grouped = all.filter((l) => GROUPED.includes(l.status));
        const covering = all.filter((l) => COVERING.includes(l.status));
        if (grouped.length < 2) return { method: this.infra.embeddingsEnabled ? 'embeddings' : 'text', threshold: this.infra.embeddingsEnabled ? embeddingThreshold : TEXT_JACCARD_THRESHOLD, patterns: [] };

        const vectors = await this.vectorsFor(all);
        const method = vectors ? 'embeddings' : 'text';
        const threshold = vectors ? embeddingThreshold : TEXT_JACCARD_THRESHOLD;
        const tokens = new Map(all.map((l) => [l.id, textTokens(l.text)]));
        const sim = (a: Lesson, b: Lesson) => (vectors
            ? cosine(vectors.get(a.text)!, vectors.get(b.text)!)
            : jaccard(tokens.get(a.id)!, tokens.get(b.id)!));

        const groups = singleLinkGroups(grouped.length, (i, j) => sim(grouped[i], grouped[j]), threshold)
            .filter((g) => g.length >= minSize)
            .map((g) => g.map((i) => grouped[i]));
        if (groups.length === 0) return { method, threshold, patterns: [] };

        const memberIds = groups.flat().map((l) => l.id);
        const sources = await this.sources.find({ where: { lessonId: In(memberIds) }, order: { createdAt: 'ASC', id: 'ASC' } });
        const jobs = await this.jobs.find({ where: { id: In([...new Set(sources.map((s) => s.jobId))]) }, select: { id: true, repoId: true, prUrl: true } });
        const jobById = new Map(jobs.map((j) => [j.id, j]));

        const patterns = groups.map((members): LessonPatternDto => {
            const memberSources = members.map((m) => sources.filter((s) => s.lessonId === m.id));
            const flat = memberSources.flat();
            const seen = [...flat.map((s) => s.createdAt), ...(flat.length ? [] : members.map((m) => m.createdAt))].map((d) => d.getTime());
            const central = members
                .map((m) => ({ m, score: members.reduce((sum, o) => (o === m ? sum : sum + sim(m, o)), 0) }))
                .sort((a, b) => b.score - a.score || byId(a.m, b.m))[0].m;
            return {
                id: sha256(members.map((m) => m.id).join(',')).slice(0, 32),
                representativeText: central.text,
                size: members.length,
                members: members.map((m, i) => ({
                    lessonId: m.id,
                    text: m.text,
                    status: m.status,
                    sources: memberSources[i].map((s) => this.mapper.toSourceDTO(s, jobById.get(s.jobId)?.prUrl ?? null)),
                })),
                jobIds: [...new Set(flat.map((s) => s.jobId))].sort(),
                runIds: [...new Set(flat.flatMap((s) => (s.runId ? [s.runId] : [])))].sort(),
                repoIds: [...new Set(flat.flatMap((s) => jobById.get(s.jobId)?.repoId ?? []))].sort(),
                firstSeen: new Date(Math.min(...seen)).toISOString(),
                lastSeen: new Date(Math.max(...seen)).toISOString(),
                alreadyCovered: covering
                    .map((c) => ({ c, score: Math.max(...members.map((m) => sim(m, c))) }))
                    .filter((x) => x.score >= threshold)
                    .sort((a, b) => b.score - a.score || byId(a.c, b.c))
                    .slice(0, MAX_COVERED)
                    .map(({ c }) => ({ lessonId: c.id, text: c.text, status: c.status, appliedJobId: c.appliedJobId })),
            };
        });
        patterns.sort((a, b) => b.size - a.size || (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0) || (a.id < b.id ? -1 : 1));
        return { method, threshold, patterns };
    }

    /** Vector per lesson text, from the cache plus one embedding request for the missing ones. Null when embeddings are off or fail. */
    private async vectorsFor(lessons: Lesson[]): Promise<Map<string, number[]> | null> {
        if (!this.infra.embeddingsEnabled) return null;
        const model = this.infra.config.embeddings ? this.infra.config.model : 'custom';
        const texts = [...new Set(lessons.map((l) => l.text))].sort();
        const hashes = new Map(texts.map((t) => [t, sha256(t)]));
        try {
            const cached = await this.embeddings.find({ where: { textHash: In([...hashes.values()]), model } });
            const byHash = new Map(cached.map((c) => [c.textHash, c.vector]));
            const missing = texts.filter((t) => !byHash.has(hashes.get(t)!));
            const size = historyOptions().embedBatchSize;
            for (let i = 0; i < missing.length; i += size) {
                const batch = missing.slice(i, i + size);
                const vectors = await this.embedder.embed(batch);
                await this.embeddings.upsert(
                    batch.map((t, k) => ({ textHash: hashes.get(t)!, model, vector: vectors[k] })),
                    ['textHash', 'model'],
                );
                batch.forEach((t, k) => byHash.set(hashes.get(t)!, vectors[k]));
            }
            return new Map(texts.map((t) => [t, byHash.get(hashes.get(t)!)!]));
        } catch {
            return null;
        }
    }
}
