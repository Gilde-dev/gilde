import { BadRequestException, NotFoundException } from '@nestjs/common';

import { Feedback } from '../../feedback/feedback.entity.js';
import { Job } from '../../job/job.entity.js';
import { Lesson } from '../../lesson/lesson.entity.js';
import { JobRun } from '../../run/run.entity.js';

import { historyHarness, type HistoryHarness } from './history.fixture.js';

let h: HistoryHarness;
afterEach(() => h.close());

const UNKNOWN = '99999999-9999-4999-8999-999999999999';

async function seed() {
    const project = await h.seed.project('Acme');
    const repo = await h.seed.repo(project, 'acme/web');
    const otherRepo = await h.seed.repo(project, 'acme/api');
    const job = await h.seed.job(repo, { title: 'Add invoice export' });
    const run = await h.seed.run(job, { result: { outcome: 'partial', summary: 'Export buffers all invoices in memory' }, retro: 'The CSV writer buffers invoices; switch to streaming' });
    const review = await h.seed.feedback(job, { body: 'Please stream the invoice export instead of buffering' });
    const lessons = {
        wide: await h.seed.lesson(project, { text: 'Stream large invoice exports instead of buffering' }),
        repo: await h.seed.lesson(project, { text: 'Web repo: stream invoice exports with the csv writer', targetRepoId: repo.id }),
        other: await h.seed.lesson(project, { text: 'Api repo: stream invoice exports with cursors', targetRepoId: otherRepo.id }),
        candidate: await h.seed.lesson(project, { text: 'Candidate: stream invoice exports', status: 'candidate' }),
    };
    const foreignProject = await h.seed.project('Foreign');
    const foreignRepo = await h.seed.repo(foreignProject, 'foreign/app');
    const foreignJob = await h.seed.job(foreignRepo, { title: 'Foreign invoice export' });
    const foreignRun = await h.seed.run(foreignJob, { retro: 'Foreign invoice export buffers in memory' });
    const foreignLesson = await h.seed.lesson(foreignProject, { text: 'Foreign: stream invoice exports' });
    await h.settle();
    return { project, repo, otherRepo, job, run, review, lessons, foreignProject, foreignRepo, foreignJob, foreignRun, foreignLesson };
}

describe('HistorySearchService.search', () => {
    it('returns ranked excerpts with source identity, repo, outcome, status and links', async () => {
        h = await historyHarness();
        const s = await seed();
        const res = await h.search.search({ projectId: s.project.id, query: 'CSV writer buffers invoices streaming' });
        expect(res.status).toBe('ok');
        if (res.status !== 'ok') return;
        expect(res.indexComplete).toBe(true);
        expect(res.results[0].score).toBeGreaterThanOrEqual(res.results[1].score);
        const run = res.results.find((r) => r.sourceType === 'run')!;
        expect(run).toMatchObject({
            sourceId: s.run.id, projectId: s.project.id, repoId: s.repo.id, repoFullName: 'acme/web', jobId: s.job.id, jobTitle: 'Add invoice export',
            runId: s.run.id, attempt: 1, outcome: 'partial', status: 'merged', prUrl: 'https://github.com/acme/web/pull/7',
        });
        expect(run.excerpt).toContain('buffers invoices');
        const review = res.results.find((r) => r.sourceType === 'review')!;
        expect(review).toMatchObject({ sourceId: s.review.id, url: 'https://github.com/acme/web/pull/7#pullrequestreview-1', jobTitle: 'Add invoice export' });
    });

    it('never mixes projects, and never returns a candidate lesson', async () => {
        h = await historyHarness();
        const s = await seed();
        const mine = await h.search.search({ projectId: s.project.id, query: 'stream invoice exports buffers memory', topK: 10 });
        const theirs = await h.search.search({ projectId: s.foreignProject.id, query: 'stream invoice exports buffers memory', topK: 10 });
        if (mine.status !== 'ok' || theirs.status !== 'ok') throw new Error('unavailable');
        expect(mine.results.every((r) => r.projectId === s.project.id)).toBe(true);
        expect(theirs.results.every((r) => r.projectId === s.foreignProject.id)).toBe(true);
        expect(theirs.results.map((r) => r.sourceId)).toEqual(expect.arrayContaining([s.foreignRun.id, s.foreignLesson.id]));
        expect(mine.results.map((r) => r.sourceId)).not.toContain(s.lessons.candidate.id);
    });

    it('restricts to a repo (plus project-wide lessons) and to the requested source types', async () => {
        h = await historyHarness();
        const s = await seed();
        const res = await h.search.search({ projectId: s.project.id, repoId: s.repo.id, query: 'stream invoice exports', topK: 10 });
        if (res.status !== 'ok') throw new Error('unavailable');
        const lessonIds = res.results.filter((r) => r.sourceType === 'lesson').map((r) => r.sourceId);
        expect(lessonIds).toEqual(expect.arrayContaining([s.lessons.wide.id, s.lessons.repo.id]));
        expect(lessonIds).not.toContain(s.lessons.other.id);
        const onlyReviews = await h.search.search({ projectId: s.project.id, query: 'stream invoice exports', types: ['review'] });
        expect(onlyReviews.status === 'ok' && onlyReviews.results.map((r) => r.sourceType)).toEqual(['review']);
    });

    it('rejects an unknown project, an unknown repo and a repo of another project', async () => {
        h = await historyHarness();
        const s = await seed();
        await expect(h.search.search({ projectId: UNKNOWN, query: 'x' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.search.search({ projectId: s.project.id, repoId: UNKNOWN, query: 'x' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.search.search({ projectId: s.project.id, repoId: s.foreignRepo.id, query: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bounds the number of results, one per source', async () => {
        h = await historyHarness();
        const s = await seed();
        const res = await h.search.search({ projectId: s.project.id, query: 'invoice export', topK: 2 });
        expect(res.status === 'ok' && res.results).toHaveLength(2);
        const wide = await h.search.search({ projectId: s.project.id, query: 'invoice export', topK: 999 });
        expect(wide.status === 'ok' && wide.results.length).toBeLessThanOrEqual(10);
        const ids = wide.status === 'ok' ? wide.results.map((r) => r.sourceId) : [];
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('revalidates against the current sources before reconciliation catches up', async () => {
        h = await historyHarness();
        const s = await seed();
        const query = { projectId: s.project.id, query: 'stream invoice exports buffers', topK: 10 } as const;
        const ids = async () => {
            const res = await h.search.search(query);
            if (res.status !== 'ok') throw new Error('unavailable');
            return res.results.map((r) => r.sourceId);
        };
        expect(await ids()).toEqual(expect.arrayContaining([s.lessons.wide.id, s.review.id, s.run.id, s.job.id]));

        await h.ds.getRepository(Lesson).update({ id: s.lessons.wide.id }, { status: 'candidate' });   // approval revoked
        await h.ds.getRepository(Feedback).delete({ id: s.review.id });                                    // deleted source
        await h.ds.getRepository(Job).update({ id: s.job.id }, { status: 'queued' });                    // reopened job
        const after = await ids();
        expect(after).not.toContain(s.lessons.wide.id);
        expect(after).not.toContain(s.review.id);
        expect(after).not.toContain(s.job.id);
        expect(after).not.toContain(s.run.id);
        const res = await h.search.search(query);
        expect(res.status === 'ok' && res.suppressed).toBeGreaterThan(0);
    });

    it('does not return the old text of an edited source', async () => {
        h = await historyHarness();
        const s = await seed();
        await h.ds.getRepository(JobRun).update({ id: s.run.id }, { retro: 'Completely different retro about login' });
        const res = await h.search.search({ projectId: s.project.id, query: 'CSV writer buffers invoices', types: ['run'] });
        expect(res.status === 'ok' && res.results.map((r) => r.sourceId)).not.toContain(s.run.id);
        await h.settle();
        const fresh = await h.search.search({ projectId: s.project.id, query: 'different retro about login', types: ['run'] });
        expect(fresh.status === 'ok' && fresh.results[0].excerpt).toContain('different retro');
    });

    it('reports an empty result as ok, and an incomplete backfill', async () => {
        h = await historyHarness();
        const project = await h.seed.project();
        const res = await h.search.search({ projectId: project.id, query: 'anything at all' });
        expect(res).toEqual({ status: 'ok', results: [], indexComplete: false, suppressed: 0 });
    });

    it('reports unavailable, not empty, when embeddings or the vector store fail, time out or are off', async () => {
        h = await historyHarness({ searchTimeoutMs: 100 });
        const s = await seed();
        h.embedder.state.failures = 1;
        const failed = await h.search.search({ projectId: s.project.id, query: 'x' });
        expect(failed).toMatchObject({ status: 'unavailable', results: [] });
        expect(failed.status === 'unavailable' && failed.reason).toContain('429');

        h.embedder.state.delayMs = 500;
        const slow = await h.search.search({ projectId: s.project.id, query: 'x' });
        expect(slow.status === 'unavailable' && slow.reason).toContain('timed out');
        h.embedder.state.delayMs = 0;

        const broken = vi.spyOn(h.infra.historyVector, 'query').mockRejectedValueOnce(new Error('vector store down'));
        const down = await h.search.search({ projectId: s.project.id, query: 'x' });
        expect(down.status === 'unavailable' && down.reason).toContain('vector store down');
        broken.mockRestore();

        expect((await h.search.search({ projectId: s.project.id, query: 'invoice' })).status).toBe('ok');
    });

    it('is unavailable when the history index is switched off', async () => {
        h = await historyHarness({ enabled: false });
        const project = await h.seed.project();
        const res = await h.search.search({ projectId: project.id, query: 'x' });
        expect(res.status).toBe('unavailable');
        expect(h.embedder.calls).toHaveLength(0);
    });
});

describe('HistorySearchService.searchLessons', () => {
    it('admits only approved-lifecycle lessons that are project-wide or target the job repo', async () => {
        h = await historyHarness();
        const s = await seed();
        const res = await h.search.searchLessons({ projectId: s.project.id, repoId: s.repo.id, query: 'stream invoice exports', topK: 10 });
        if (res.status !== 'ok') throw new Error('unavailable');
        const ids = res.lessons.map((l) => l.lessonId);
        expect(ids.sort()).toEqual([s.lessons.wide.id, s.lessons.repo.id].sort());
        expect(res.lessons[0]).toMatchObject({ projectId: s.project.id, status: 'approved' });
        expect(res.lessons.find((l) => l.lessonId === s.lessons.repo.id)?.targetRepoId).toBe(s.repo.id);
    });

    it('returns nothing from reviews, retros, other projects or personal memory', async () => {
        h = await historyHarness();
        const s = await seed();
        const res = await h.search.searchLessons({ projectId: s.project.id, repoId: s.repo.id, query: 'CSV writer buffers invoices retro review', topK: 10 });
        if (res.status !== 'ok') throw new Error('unavailable');
        const lessonIds = new Set([s.lessons.wide.id, s.lessons.repo.id, s.lessons.other.id]);
        expect(res.lessons.every((l) => lessonIds.has(l.lessonId) && l.lessonId !== s.lessons.other.id)).toBe(true);
        expect(res.lessons.map((l) => l.lessonId)).not.toContain(s.foreignLesson.id);
    });

    it('drops a revoked lesson immediately, applies the relevance threshold, and reports failures as unavailable', async () => {
        h = await historyHarness();
        const s = await seed();
        await h.ds.getRepository(Lesson).update({ id: s.lessons.repo.id }, { status: 'rejected' });
        const res = await h.search.searchLessons({ projectId: s.project.id, repoId: s.repo.id, query: 'stream invoice exports', topK: 10 });
        expect(res.status === 'ok' && res.lessons.map((l) => l.lessonId)).toEqual([s.lessons.wide.id]);

        const strict = await h.search.searchLessons({ projectId: s.project.id, repoId: s.repo.id, query: 'completely unrelated gardening tips', minScore: 0.9 });
        expect(strict).toEqual({ status: 'ok', lessons: [] });

        await expect(h.search.searchLessons({ projectId: s.project.id, repoId: s.foreignRepo.id, query: 'x' })).rejects.toBeInstanceOf(BadRequestException);
        h.embedder.state.failures = 1;
        expect((await h.search.searchLessons({ projectId: s.project.id, repoId: s.repo.id, query: 'x' })).status).toBe('unavailable');
    });
});
