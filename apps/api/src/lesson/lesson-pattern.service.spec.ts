import { DataSource } from 'typeorm';

import { LessonMapper } from './lesson.mapper.js';
import { LessonEmbedding } from './lesson-embedding.entity.js';
import { LessonPatternService } from './lesson-pattern.service.js';
import { Lesson } from './lesson.entity.js';
import { LessonSource } from './lesson-source.entity.js';
import { Job } from '../job/job.entity.js';
import { J1, J2, P1, P2, ENTITIES, memoryDb } from './lesson.fixture.js';
import { lessonPatternSimilarity } from './lesson-pattern.config.js';
import { jaccard, singleLinkGroups, textTokens } from './lesson-pattern.grouping.js';
import type { LessonStatus } from './lesson-state.js';

const A = 'Run pnpm install first in a fresh session';
const B = 'Always run `pnpm install` first, in a fresh session!';
const C = 'The e2e database is shared between test files';

function setup(opts: { vectors?: Record<string, number[]>; failEmbed?: boolean } = {}) {
    const calls: string[][] = [];
    const infra = opts.vectors || opts.failEmbed
        ? {
            embeddingsEnabled: true,
            embeddingDimension: undefined,
            config: { embeddings: true, model: 'openai/fake', dimension: 2 },
            embedder: {
                doEmbed: async ({ values }: { values: string[] }) => {
                    calls.push(values);
                    if (opts.failEmbed) throw new Error('down');
                    return { embeddings: values.map((v) => opts.vectors![v] ?? [0, 0]), usage: { tokens: values.length } };
                },
            },
        }
        : { embeddingsEnabled: false, embeddingDimension: undefined, config: { embeddings: false, reason: 'off' }, embedder: undefined };
    return { infra, calls };
}

describe('LessonPatternService', () => {
    let ds: DataSource;
    const projects = { getById: vi.fn().mockResolvedValue({ id: P1 }) };
    const service = (infra: unknown) => new LessonPatternService(
        ds.getRepository(Lesson), ds.getRepository(LessonSource), ds.getRepository(LessonEmbedding), ds.getRepository(Job),
        infra as never, projects as never, new LessonMapper(),
    );
    let n = 0;
    const lesson = (text: string, status: LessonStatus = 'candidate', projectId = P1) =>
        ds.getRepository(Lesson).save({ projectId, text, status, createdAt: new Date(Date.UTC(2026, 0, 1 + n++)) });
    const source = (lessonId: string, jobId: string, createdAt = new Date(Date.UTC(2026, 1, 1 + n++))) =>
        ds.getRepository(LessonSource).save({ lessonId, sourceKey: `suggested_lesson:${n}-${lessonId}`, kind: 'suggested_lesson', jobId, runId: null, excerpt: 'x', createdAt });

    beforeEach(async () => {
        ds = await memoryDb();
        await ds.destroy();
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [...ENTITIES, LessonEmbedding], synchronize: true }).initialize();
        delete process.env.LESSON_PATTERN_SIMILARITY;
    });
    afterEach(() => ds.destroy());

    it('groups similar lessons with the text fallback and excludes singletons', async () => {
        const a = await lesson(A);
        const b = await lesson(B);
        await lesson(C);
        await source(a.id, J1);
        await source(b.id, J2);
        const res = await service(setup().infra).list(P1);
        expect(res.method).toBe('text');
        expect(res.patterns).toHaveLength(1);
        const p = res.patterns[0];
        expect(p.size).toBe(2);
        expect(p.members.map((m) => m.lessonId).sort()).toEqual([a.id, b.id].sort());
        expect(p.jobIds).toEqual([J1, J2].sort());
        expect(p.id).toMatch(/^[0-9a-f]{32}$/);
        expect([A, B]).toContain(p.representativeText);
        expect(new Date(p.firstSeen) <= new Date(p.lastSeen)).toBe(true);
    });

    it('is deterministic and the id depends only on the member ids', async () => {
        await lesson(A);
        await lesson(B);
        const first = await service(setup().infra).list(P1);
        const second = await service(setup().infra).list(P1);
        expect(second).toEqual(first);
    });

    it('groups with cached embeddings, single-link, and embeds each text once', async () => {
        const vectors = { [A]: [1, 0], [B]: [0.9, 0.2], [C]: [0.6, 0.9] };
        const x = await lesson(A);
        await lesson(B);
        await lesson(C);
        process.env.LESSON_PATTERN_SIMILARITY = '0.9';
        const { infra, calls } = setup({ vectors });
        const res = await service(infra).list(P1);
        expect(res.method).toBe('embeddings');
        expect(res.threshold).toBe(0.9);
        expect(res.patterns).toHaveLength(1);
        expect(res.patterns[0].members.map((m) => m.lessonId)).toContain(x.id);
        expect(calls.flat().sort()).toEqual([A, B, C].sort());
        expect(await ds.getRepository(LessonEmbedding).count()).toBe(3);
        await service(infra).list(P1);
        expect(calls).toHaveLength(1);
    });

    it('uses the threshold: lower groups more, higher groups fewer', async () => {
        const vectors = { [A]: [1, 0], [C]: [0.8, 0.6] };
        await lesson(A);
        await lesson(C);
        process.env.LESSON_PATTERN_SIMILARITY = '0.99';
        expect((await service(setup({ vectors }).infra).list(P1)).patterns).toHaveLength(0);
        process.env.LESSON_PATTERN_SIMILARITY = '0.7';
        expect((await service(setup({ vectors }).infra).list(P1)).patterns).toHaveLength(1);
    });

    it('fails closed on an invalid threshold', async () => {
        await lesson(A);
        await lesson(B);
        for (const bad of ['abc', '0', '1.5', '-1']) {
            process.env.LESSON_PATTERN_SIMILARITY = bad;
            await expect(service(setup().infra).list(P1)).rejects.toThrow(/LESSON_PATTERN_SIMILARITY/);
        }
        expect(lessonPatternSimilarity({})).toBe(0.85);
        expect(lessonPatternSimilarity({ LESSON_PATTERN_SIMILARITY: ' 0.5 ' })).toBe(0.5);
    });

    it('falls back to text when the embedder fails', async () => {
        await lesson(A);
        await lesson(B);
        const res = await service(setup({ failEmbed: true }).infra).list(P1);
        expect(res.method).toBe('text');
        expect(res.patterns).toHaveLength(1);
    });

    it('ignores rejected lessons, shows applied ones as covered context and does not group them', async () => {
        await lesson(A);
        await lesson(B);
        await lesson(A, 'rejected');
        const applied = await lesson(A, 'applied');
        const res = await service(setup().infra).list(P1);
        expect(res.patterns).toHaveLength(1);
        expect(res.patterns[0].size).toBe(2);
        expect(res.patterns[0].alreadyCovered.map((c) => c.lessonId)).toEqual([applied.id]);
    });

    it('is scoped to the project and honours minSize and ordering by size then recency', async () => {
        await lesson(A, 'approved');
        await lesson(B, 'approved');
        await lesson(A, 'candidate', P2);
        await lesson(B, 'candidate', P2);
        await lesson(C);
        await lesson(`${C} files`);
        await lesson(`${C} files too`);
        const res = await service(setup().infra).list(P1);
        expect(res.patterns.map((p) => p.size)).toEqual([3, 2]);
        expect(res.patterns.flatMap((p) => p.members.map((m) => m.lessonId))).toHaveLength(5);
        expect((await service(setup().infra).list(P1, { minSize: 3 })).patterns).toHaveLength(1);
    });

    it('text helpers', () => {
        expect([...textTokens('Use `pnpm`, then Test!')].sort()).toEqual(['test', 'then', 'use']);
        expect(jaccard(new Set(), new Set(['a']))).toBe(0);
        expect(singleLinkGroups(3, (i, j) => (i + j === 1 || i + j === 3 ? 1 : 0), 0.5)).toEqual([[0, 1, 2]]);
    });
});
