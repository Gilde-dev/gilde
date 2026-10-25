import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Lesson } from '../lesson/lesson.entity.js';
import { historyHarness, type HistoryHarness } from '../memory/history/history.fixture.js';
import type { HistoryLessonHitDto } from '../memory/history/history.dto.js';
import { JobPayloadSchema } from './execution.port.js';
import { LESSONS_MAX_COUNT, LESSONS_TOTAL_LIMIT, LESSON_TEXT_LIMIT, lessonRetrievalOptions, selectJobLessons } from './job-lessons.js';

const job = { projectId: 'p1', repoId: 'r1', title: 'Add export', task: 'Stream invoices', acceptanceCriteria: ['streams'], stacks: ['node'] };
const options = { topK: 5, minScore: 0.5, timeoutMs: 200 };
const hit = (over: Partial<HistoryLessonHitDto> = {}): HistoryLessonHitDto => ({
    lessonId: 'l1', projectId: 'p1', targetRepoId: null, status: 'approved', score: 0.9, text: 'Stream large exports', ...over,
});
const history = (result: unknown) => ({ searchLessons: vi.fn().mockImplementation(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))) });
const ok = (...lessons: HistoryLessonHitDto[]) => ({ status: 'ok', lessons });

afterEach(() => vi.restoreAllMocks());

describe('selectJobLessons', () => {
    it('queries with title, task, criteria and stacks, bounded, and returns cited lessons', async () => {
        const h = history(ok(hit(), hit({ lessonId: 'l2', targetRepoId: 'r1', status: 'applied', score: 0.7 })));
        const lessons = await selectJobLessons(h, { ...job, task: 'x'.repeat(5000) }, options);
        const arg = h.searchLessons.mock.calls[0]![0];
        expect(arg).toMatchObject({ projectId: 'p1', repoId: 'r1', topK: 5, minScore: 0.5 });
        expect(arg.query).toContain('Add export');
        expect(arg.query.length).toBeLessThanOrEqual(2000);
        expect(lessons).toEqual([
            { id: 'l1', text: 'Stream large exports', scope: 'project', status: 'approved', relevance: 0.9 },
            { id: 'l2', text: 'Stream large exports', scope: 'repo', status: 'applied', relevance: 0.7 },
        ]);
        expect(() => JobPayloadSchema.shape.lessons.parse(lessons)).not.toThrow();
    });

    it('revalidates scope, lifecycle and relevance, and drops duplicates instead of filling a quota', async () => {
        const lessons = await selectJobLessons(history(ok(
            hit({ lessonId: 'keep' }),
            hit({ lessonId: 'keep', score: 0.8 }),
            hit({ lessonId: 'foreign', projectId: 'p2' }),
            hit({ lessonId: 'other-repo', targetRepoId: 'r2' }),
            hit({ lessonId: 'revoked', status: 'rejected' }),
            hit({ lessonId: 'candidate', status: 'candidate' }),
            hit({ lessonId: 'weak', score: 0.2 }),
            hit({ lessonId: 'empty', text: '  ' }),
        )), job, options);
        expect(lessons.map((l) => l.id)).toEqual(['keep']);
    });

    it('caps the count, the text of a lesson and the total characters', async () => {
        const many = Array.from({ length: 9 }, (_, i) => hit({ lessonId: `l${i}`, score: 0.99 - i / 100, text: 'y'.repeat(LESSON_TEXT_LIMIT + 500) }));
        const lessons = await selectJobLessons(history(ok(...many)), job, options);
        expect(lessons.length).toBeLessThanOrEqual(LESSONS_MAX_COUNT);
        expect(lessons.every((l) => l.text.length <= LESSON_TEXT_LIMIT)).toBe(true);
        expect(lessons.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(LESSONS_TOTAL_LIMIT);
        expect(lessons[0]!.id).toBe('l0');
    });

    it.each([
        ['unavailable (no credentials/index)', { status: 'unavailable', reason: 'History search needs embeddings: OPENAI_API_KEY is not set', lessons: [] }],
        ['an empty index', ok()],
        ['a rate limit', new Error('429 Too Many Requests')],
        ['a vector error', new Error('vector store exploded')],
    ])('fails open on %s', async (_name, result) => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        expect(await selectJobLessons(history(result), job, options)).toEqual([]);
        if (result instanceof Error || (result as { status: string }).status === 'unavailable') expect(warn).toHaveBeenCalledOnce();
    });

    it('fails open at the hard timeout, with a bounded diagnostic', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const slow = { searchLessons: vi.fn().mockReturnValue(new Promise(() => undefined)) };
        expect(await selectJobLessons(slow, job, { ...options, timeoutMs: 20 })).toEqual([]);
        expect(String(warn.mock.calls[0]![0])).toContain('timed out after 20 ms');

        warn.mockClear();
        await selectJobLessons(history(new Error('z'.repeat(5000))), job, options);
        expect(String(warn.mock.calls[0]![0]).length).toBeLessThan(400);
    });

    it('does not search when topK is 0', async () => {
        const h = history(ok(hit()));
        expect(await selectJobLessons(h, job, { ...options, topK: 0 })).toEqual([]);
        expect(h.searchLessons).not.toHaveBeenCalled();
    });

    it('reads bounds from the environment with safe defaults', () => {
        expect(lessonRetrievalOptions({})).toEqual({ topK: 5, minScore: 0.5, timeoutMs: 3000 });
        expect(lessonRetrievalOptions({ DISPATCH_LESSONS_TOP_K: '2', DISPATCH_LESSONS_MIN_SCORE: '0.7', DISPATCH_LESSONS_TIMEOUT_MS: '500' })).toEqual({ topK: 2, minScore: 0.7, timeoutMs: 500 });
        expect(lessonRetrievalOptions({ DISPATCH_LESSONS_TOP_K: '99', DISPATCH_LESSONS_MIN_SCORE: '7', DISPATCH_LESSONS_TIMEOUT_MS: '1' })).toEqual({ topK: 5, minScore: 0.5, timeoutMs: 3000 });
    });
});

describe('selectJobLessons against the real history index', () => {
    let h: HistoryHarness;
    afterEach(() => h.close());

    it('returns project and repo lessons only, and stops returning an approval revoked after indexing', async () => {
        h = await historyHarness();
        const project = await h.seed.project('Acme');
        const repo = await h.seed.repo(project, 'acme/web');
        const otherRepo = await h.seed.repo(project, 'acme/api');
        const wide = await h.seed.lesson(project, { text: 'Stream large invoice exports instead of buffering' });
        const mine = await h.seed.lesson(project, { text: 'Web: stream invoice exports with the csv writer', targetRepoId: repo.id });
        const theirs = await h.seed.lesson(project, { text: 'Api: stream invoice exports with cursors', targetRepoId: otherRepo.id });
        const candidate = await h.seed.lesson(project, { text: 'Candidate: stream invoice exports', status: 'candidate' });
        const foreign = await h.seed.lesson(await h.seed.project('Foreign'), { text: 'Foreign: stream invoice exports' });
        const jb = await h.seed.job(repo, { title: 'Stream invoice exports' });
        await h.settle();
        const input = { projectId: project.id, repoId: repo.id, title: jb.title, task: jb.task, acceptanceCriteria: jb.acceptanceCriteria, stacks: ['node'] };
        const open = { topK: 5, minScore: 0, timeoutMs: 5000 };

        const ids = (await selectJobLessons(h.search, input, open)).map((l) => l.id).sort();
        expect(ids).toEqual([wide.id, mine.id].sort());
        for (const excluded of [theirs, candidate, foreign]) expect(ids).not.toContain(excluded.id);

        await h.ds.getRepository(Lesson).update({ id: mine.id }, { status: 'rejected' });
        expect((await selectJobLessons(h.search, input, open)).map((l) => l.id)).toEqual([wide.id]);
    });

    it('is empty with an empty index and when the embedder fails', async () => {
        h = await historyHarness();
        const project = await h.seed.project('Acme');
        const repo = await h.seed.repo(project, 'acme/web');
        const input = { projectId: project.id, repoId: repo.id, title: 't', task: 'k', acceptanceCriteria: [], stacks: [] };
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        expect(await selectJobLessons(h.search, input, { topK: 5, minScore: 0, timeoutMs: 5000 })).toEqual([]);
        h.embedder.state.failures = 1;
        expect(await selectJobLessons(h.search, input, { topK: 5, minScore: 0, timeoutMs: 5000 })).toEqual([]);
    });
});
