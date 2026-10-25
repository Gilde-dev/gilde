import { Feedback } from '../../feedback/feedback.entity.js';
import { Job } from '../../job/job.entity.js';
import { Lesson } from '../../lesson/lesson.entity.js';
import { JobRun } from '../../run/run.entity.js';

import { historyHarness, type HistoryHarness } from './history.fixture.js';

let h: HistoryHarness;
afterEach(() => h.close());

/** One project with: a merged job (two runs), a parked job, a queued job, lessons in every state and feedback of every kind. */
async function seedFactory() {
    const project = await h.seed.project();
    const repo = await h.seed.repo(project);
    const merged = await h.seed.job(repo, { title: 'Add export endpoint' });
    const runDone = await h.seed.run(merged, { result: { outcome: 'partial', summary: 'Export works but no streaming' }, retro: 'The CSV library buffers everything in memory', ciConclusion: 'failure' });
    const runBlocked = await h.seed.run(merged, { result: { outcome: 'done', summary: 'Streams rows now' }, retro: 'Switched to a streaming writer', ciConclusion: 'success' });
    const parked = await h.seed.job(repo, { title: 'Fix flaky login test', status: 'parked', prNumber: null, prUrl: null });
    const runFailed = await h.seed.run(parked, { status: 'fire_failed', error: 'routine returned 429' });
    const queued = await h.seed.job(repo, { title: 'Still waiting', status: 'queued' });
    const queuedRun = await h.seed.run(queued, { retro: 'should not be indexed' });
    const lessons = {
        candidate: await h.seed.lesson(project, { status: 'candidate', text: 'candidate lesson' }),
        rejected: await h.seed.lesson(project, { status: 'rejected', text: 'rejected lesson' }),
        approved: await h.seed.lesson(project, { status: 'approved', text: 'Run the migrations before the e2e tests' }),
        applying: await h.seed.lesson(project, { status: 'applying', text: 'Pin the node version in CI' }),
        applied: await h.seed.lesson(project, { status: 'applied', text: 'Use the streaming writer for exports', targetRepoId: repo.id }),
    };
    const review = await h.seed.feedback(merged, { kind: 'review' });
    const comment = await h.seed.feedback(merged, { kind: 'review_comment', path: 'src/export.ts', line: 12, body: 'Avoid buffering here', url: 'https://github.com/acme/web/pull/7#discussion_r1' });
    const issueComment = await h.seed.feedback(merged, { kind: 'comment', body: '/gilde retry' });
    const emptyReview = await h.seed.feedback(merged, { kind: 'review', body: '  ' });
    return { project, repo, merged, runDone, runBlocked, parked, runFailed, queued, queuedRun, lessons, review, comment, issueComment, emptyReview };
}

const sourceIds = (ids: string[]) => [...new Set(ids.map((id) => id.split(':').slice(0, 2).join(':')))].sort();

describe('HistoryIndexService backfill', () => {
    it('indexes terminal and parked jobs with all runs, approved-lifecycle lessons, reviews and review comments, and nothing else', async () => {
        h = await historyHarness();
        const s = await seedFactory();
        await h.settle();
        expect(sourceIds(await h.chunkIds())).toEqual([
            `job:${s.merged.id}`, `job:${s.parked.id}`,
            `run:${s.runDone.id}`, `run:${s.runBlocked.id}`, `run:${s.runFailed.id}`,
            `lesson:${s.lessons.approved.id}`, `lesson:${s.lessons.applying.id}`, `lesson:${s.lessons.applied.id}`,
            `review:${s.review.id}`, `review_comment:${s.comment.id}`,
        ].sort());
        const status = await h.index.status();
        expect(status).toMatchObject({ indexedSources: 10, passInProgress: false, lastError: null });
        expect(status.lastCompletedAt).not.toBeNull();
    });

    it('has deterministic chunk ids and text, and represents missing results and retros honestly', async () => {
        h = await historyHarness();
        const s = await seedFactory();
        await h.settle();
        const ids = await h.chunkIds();
        expect(ids).toContain(`run:${s.runFailed.id}:0`);
        const hits = await h.search.search({ projectId: s.project.id, query: 'routine returned 429 no result recorded', types: ['run'] });
        expect(hits.status).toBe('ok');
        const failed = hits.status === 'ok' ? hits.results.find((r) => r.sourceId === s.runFailed.id) : undefined;
        expect(failed?.excerpt).toContain('No agent result was recorded');
        expect(failed?.excerpt).toContain('Retro: none recorded');
        expect(failed?.excerpt).toContain('routine returned 429');
    });

    it('never touches personal memory: no co-pilot conversation can reach the index', async () => {
        h = await historyHarness();
        await seedFactory();
        await h.settle();
        const stored = JSON.stringify(await h.infra.historyVector.query({ indexName: h.infra.historyIndexName, queryVector: Array.from({ length: 64 }, () => 0.1), topK: 1000 }));
        expect(stored).not.toMatch(/thread|working memory|resourceId/i);
        expect(h.infra.historyIndexName).not.toBe('memory_messages_64');
    });
});

describe('HistoryIndexService reconciliation', () => {
    it('does not re-embed unchanged content on repeated passes', async () => {
        h = await historyHarness();
        await seedFactory();
        await h.settle();
        const embedded = h.embedder.calls.flat().length;
        const idsBefore = await h.chunkIds();
        await h.settle();
        await h.settle();
        expect(h.embedder.calls.flat().length).toBe(embedded);
        expect(await h.chunkIds()).toEqual(idsBefore);
    });

    it('is idle until the freshness window has passed', async () => {
        h = await historyHarness({ freshnessMs: 60_000 });
        await seedFactory();
        await h.settle();
        expect((await h.index.reconcile()).outcome).toBe('idle');
    });

    it('works in bounded batches and resumes after a restart without redoing or skipping work', async () => {
        h = await historyHarness({ batchSize: 2, maxBatchesPerRun: 2 });
        const s = await seedFactory();
        const first = await h.index.reconcile();
        expect(first).toMatchObject({ outcome: 'partial', batches: 2 });
        const midway = await h.index.status();
        expect(midway.passInProgress).toBe(true);
        const embeddedBefore = h.embedder.calls.flat().length;
        expect(embeddedBefore).toBeGreaterThan(0);

        h.restart();
        expect((await h.index.status()).progress).toEqual(midway.progress);
        await h.settle();
        const ids = await h.chunkIds();
        expect(sourceIds(ids)).toHaveLength(10);
        expect(ids).toContain(`review:${s.review.id}:0`);
        // Every chunk was embedded exactly once across the restart.
        expect(h.embedder.calls.flat().length).toBe(ids.length);
    });

    it('picks up late-arriving retros and results, and new feedback', async () => {
        h = await historyHarness();
        const s = await seedFactory();
        await h.settle();
        const before = h.embedder.calls.flat().length;
        await h.ds.getRepository(JobRun).update({ id: s.runDone.id }, { retro: 'Late retro: the CSV library needed a streaming flag' });
        const late = await h.seed.feedback(s.merged, { kind: 'review_comment', path: 'a.ts', line: 1, body: 'Late inline comment about pagination' });
        await h.settle();
        expect(h.embedder.calls.flat().length - before).toBe(2);
        expect(await h.chunkIds()).toContain(`review_comment:${late.id}:0`);
        const hit = await h.search.search({ projectId: s.project.id, query: 'streaming flag late retro', types: ['run'] });
        expect(hit.status === 'ok' && hit.results[0].excerpt).toContain('Late retro');
    });

    it('removes chunks when a lesson approval is revoked, a job is requeued, or a source is deleted, and when a source shrinks', async () => {
        h = await historyHarness();
        const s = await seedFactory();
        await h.settle();

        await h.ds.getRepository(Lesson).update({ id: s.lessons.approved.id }, { status: 'candidate' });
        await h.ds.getRepository(Job).update({ id: s.parked.id }, { status: 'queued' });
        await h.ds.getRepository(Feedback).delete({ id: s.review.id });
        await h.settle();
        const ids = sourceIds(await h.chunkIds());
        expect(ids).not.toContain(`lesson:${s.lessons.approved.id}`);
        expect(ids).not.toContain(`job:${s.parked.id}`);
        expect(ids).not.toContain(`run:${s.runFailed.id}`);
        expect(ids).not.toContain(`review:${s.review.id}`);
        expect(ids).toHaveLength(6);

        // A job that is finished again qualifies again.
        await h.ds.getRepository(Job).update({ id: s.parked.id }, { status: 'cancelled' });
        await h.settle();
        expect(sourceIds(await h.chunkIds())).toContain(`run:${s.runFailed.id}`);

        // Shrinking a multi-chunk source drops the stale tail.
        await h.ds.getRepository(JobRun).update({ id: s.runDone.id }, { retro: 'long line '.repeat(400) });
        await h.settle();
        const many = (await h.chunkIds()).filter((id) => id.startsWith(`run:${s.runDone.id}:`));
        expect(many.length).toBeGreaterThan(2);
        await h.ds.getRepository(JobRun).update({ id: s.runDone.id }, { retro: 'short' });
        await h.settle();
        expect((await h.chunkIds()).filter((id) => id.startsWith(`run:${s.runDone.id}:`))).toEqual([`run:${s.runDone.id}:0`]);
    });

    it('bounds chunk size and count', async () => {
        h = await historyHarness();
        const project = await h.seed.project();
        const repo = await h.seed.repo(project);
        const job = await h.seed.job(repo);
        const run = await h.seed.run(job, { retro: 'word '.repeat(20_000) });
        await h.settle();
        const ids = (await h.chunkIds()).filter((id) => id.startsWith(`run:${run.id}:`));
        expect(ids).toHaveLength(8);
        for (const text of h.embedder.calls.flat()) expect(text.length).toBeLessThanOrEqual(1200);
    });
});

describe('HistoryIndexService failures', () => {
    it('keeps the cursor on failure, reports it, and retries safely without duplicates', async () => {
        h = await historyHarness({ batchSize: 3 });
        await seedFactory();
        const ok = await h.index.reconcile();
        expect(ok.outcome).toBe('complete');
        // New content, then an outage.
        const project = await h.seed.project('Other');
        const repo = await h.seed.repo(project);
        await h.seed.lesson(project, { text: 'brand new lesson' });
        await h.seed.job(repo, { title: 'second' });
        h.embedder.state.failures = 1;
        const failed = await h.index.reconcile();
        expect(failed).toMatchObject({ outcome: 'failed' });
        expect(failed.error).toContain('429');
        expect(await h.index.status()).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringContaining('429') });

        await h.settle();
        const status = await h.index.status();
        expect(status).toMatchObject({ consecutiveFailures: 0, lastError: null, indexedSources: 12 });
        const ids = await h.chunkIds();
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('retries an embedding request before failing the batch', async () => {
        h = await historyHarness({ embedAttempts: 3 });
        await seedFactory();
        h.embedder.state.failures = 2;
        expect((await h.index.reconcile()).outcome).toBe('complete');
    });

    it('does nothing and does not embed when embeddings are off', async () => {
        h = await historyHarness({ enabled: false });
        await seedFactory();
        expect((await h.index.reconcile()).outcome).toBe('disabled');
        expect(h.embedder.calls).toHaveLength(0);
        expect(await h.index.status()).toMatchObject({ enabled: false, indexedSources: 0 });
    });

    it('serializes overlapping reconcile calls onto one pass', async () => {
        h = await historyHarness();
        await seedFactory();
        const [a, b] = await Promise.all([h.index.reconcile(), h.index.reconcile()]);
        expect(a).toBe(b);
        expect(h.embedder.calls.flat().length).toBe((await h.chunkIds()).length);
    });
});

describe('HistoryIndexService rebuild', () => {
    it('drops everything and re-embeds from the sources, also removing orphaned chunks', async () => {
        h = await historyHarness();
        const s = await seedFactory();
        await h.settle();
        // An orphan the bookkeeping does not know about (e.g. after a crash).
        await h.infra.historyVector.upsert({ indexName: h.infra.historyIndexName, vectors: [Array.from({ length: 64 }, () => 0.1)], ids: ['lesson:orphan:0'], metadata: [{ sourceType: 'lesson', sourceId: 'orphan', projectId: s.project.id, repoId: '', contentHash: 'x', text: 'orphan' }] });
        expect(await h.chunkIds()).toContain('lesson:orphan:0');
        const before = h.embedder.calls.flat().length;

        const result = await h.index.rebuild();
        expect(['complete', 'partial']).toContain(result.outcome);
        await h.settle();
        const ids = await h.chunkIds();
        expect(ids).not.toContain('lesson:orphan:0');
        expect(sourceIds(ids)).toHaveLength(10);
        expect(h.embedder.calls.flat().length - before).toBe(ids.length);
    });
});
