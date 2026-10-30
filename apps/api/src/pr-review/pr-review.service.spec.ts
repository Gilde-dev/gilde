import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Job } from '../job/job.entity.js';
import { User } from '../user/user.entity.js';

import { PrReview } from './pr-review.entity.js';
import { PrReviewService } from './pr-review.service.js';
import type { ReviewLimits, ReviewResult } from './review-result.js';

const LIMITS: ReviewLimits = { timeoutMs: 60_000, maxSteps: 8, maxInputTokens: 100_000, maxOutputTokens: 4_000, maxRevisions: 2 };
const finding = { title: 'Bug', evidence: 'a.ts:1 divides by zero', path: 'a.ts', line: 1, impact: 'crash', requestedFix: 'guard it' };
const pass: ReviewResult = {
    kind: 'complete', verdict: 'pass', summary: 'ok', inspection: { diffComplete: true, contextComplete: true },
    coverage: [], blockingFindings: [], suggestions: [],
};
const blocking: ReviewResult = { ...pass, verdict: 'blocking', blockingFindings: [finding] };
const tooLarge: ReviewResult = { kind: 'incomplete', reasonCode: 'too_large', reason: 'too large', partialFindings: [], suggestions: [] };

describe('PrReviewService', () => {
    let ds: DataSource;
    let service: PrReviewService;
    const make = () => new PrReviewService(ds.getRepository(PrReview), ds.getRepository(Job), ds);
    const jobs = () => ds.getRepository(Job);
    const reviews = () => ds.getRepository(PrReview);

    beforeEach(async () => {
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [PrReview, Job, User], synchronize: true }).initialize();
        service = make();
    });
    afterEach(() => ds.destroy());

    const newJob = (over: Partial<Job> = {}) => jobs().save(jobs().create({
        projectId: randomUUID(), repoId: randomUUID(), title: 'Job', task: 'Do it', status: 'pr_open', prNumber: 7, headSha: 'sha1', prUrl: 'https://github.com/o/r/pull/7', ...over,
    }));
    const target = (job: Job, headSha = job.headSha!) => ({ jobId: job.id, prNumber: job.prNumber!, headSha, limits: LIMITS });
    const claimed = async (job: Job) => {
        const r = await service.claimExecution(target(job));
        if (!r.claimed) throw new Error('not claimed');
        return r.review;
    };
    const finished = async (job: Job, result: ReviewResult) => {
        const r = await claimed(job);
        await service.markRunning(r.id);
        await service.complete(r.id, result);
        return r;
    };

    describe('claiming', () => {
        it('gives concurrent claims of one head a single execution owner', async () => {
            const job = await newJob();
            const results = await Promise.all(Array.from({ length: 8 }, () => service.claimExecution(target(job))));
            expect(results.filter((r) => r.claimed)).toHaveLength(1);
            expect(results.filter((r) => !r.claimed).every((r) => !r.claimed && r.reason === 'exists' && r.review?.id)).toBe(true);
            expect(await reviews().countBy({ jobId: job.id })).toBe(1);
        });

        it('keeps the claim across service recreation, and a new head gets its own review', async () => {
            const job = await newJob();
            expect((await service.claimExecution(target(job))).claimed).toBe(true);
            const restarted = make();
            expect((await restarted.claimExecution(target(job))).claimed).toBe(false);
            await jobs().update(job.id, { headSha: 'sha2' });
            expect((await restarted.claimExecution(target(job, 'sha2'))).claimed).toBe(true);
            expect(await reviews().countBy({ jobId: job.id })).toBe(2);
        });

        it('refuses a stale head, another PR and a job that is no longer waiting for its gate', async () => {
            const job = await newJob();
            expect(await service.claimExecution(target(job, 'old'))).toMatchObject({ claimed: false, reason: 'stale' });
            expect(await service.claimExecution({ ...target(job), prNumber: 8 })).toMatchObject({ claimed: false, reason: 'stale' });
            const moved = await newJob({ status: 'awaiting_review' });
            expect(await service.claimExecution(target(moved))).toMatchObject({ claimed: false, reason: 'stale', review: null });
            expect(await reviews().count()).toBe(0);
        });

        it('records a skip once per head, distinct from a pass, with its identity', async () => {
            const job = await newJob();
            const a = await service.recordSkip(target(job), { kind: 'skipped', reasonCode: 'project_opt_out', reason: 'Automatic review is off for this project' });
            expect(a.claimed).toBe(true);
            expect((await service.recordSkip(target(job), { kind: 'skipped', reasonCode: 'project_opt_out', reason: 'x' })).claimed).toBe(false);
            const row = await reviews().findOneByOrFail({ jobId: job.id });
            expect(row).toMatchObject({ status: 'skipped', verdict: null, reasonCode: 'project_opt_out', projectId: job.projectId, repoId: job.repoId, headSha: 'sha1', prNumber: 7 });
        });

        it('stores job, repo, PR, head and base identity and the limits snapshot', async () => {
            const job = await newJob();
            const r = await service.claimExecution({ ...target(job), baseSha: 'base1', baseRef: 'main' });
            expect(r.claimed && r.review).toMatchObject({ status: 'pending', baseSha: 'base1', baseRef: 'main', limits: LIMITS, projectId: job.projectId });
        });
    });

    describe('execution', () => {
        it('lets exactly one caller start the model execution', async () => {
            const r = await claimed(await newJob());
            const starts = await Promise.all([service.markRunning(r.id), make().markRunning(r.id), service.markRunning(r.id)]);
            expect(starts.filter(Boolean)).toHaveLength(1);
            expect(await reviews().findOneByOrFail({ id: r.id })).toMatchObject({ status: 'running', claimedBy: expect.any(String) });
        });

        it('does not start when the job moved on', async () => {
            const job = await newJob();
            const r = await claimed(job);
            await jobs().update(job.id, { headSha: 'sha2' });
            expect(await service.markRunning(r.id)).toBe(false);
            expect((await reviews().findOneByOrFail({ id: r.id })).status).toBe('pending');
        });

        it('persists the first valid result with usage and ignores a second one', async () => {
            const r = await claimed(await newJob());
            await service.markRunning(r.id);
            const done = await service.complete(r.id, blocking, { model: 'openai/x', inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
            expect(done).toMatchObject({ status: 'complete', verdict: 'blocking', model: 'openai/x', inputTokens: 10, costUsd: 0.01, result: blocking });
            expect(await service.complete(r.id, pass)).toBeNull();
            expect((await reviews().findOneByOrFail({ id: r.id })).verdict).toBe('blocking');
        });

        it('rejects an invalid result and keeps the review unfinished', async () => {
            const r = await claimed(await newJob());
            await service.markRunning(r.id);
            const bad = { ...pass, inspection: { diffComplete: false, contextComplete: true } } as unknown as ReviewResult;
            await expect(service.complete(r.id, bad)).rejects.toThrow();
            expect((await reviews().findOneByOrFail({ id: r.id })).status).toBe('running');
        });

        it('lets a preflight "too large" finish without a model call, with no verdict', async () => {
            const r = await claimed(await newJob());
            const done = await service.complete(r.id, tooLarge);
            expect(done).toMatchObject({ status: 'incomplete', verdict: null, reasonCode: 'too_large', reason: 'too large', startedAt: null });
        });

        it('stores the publication once', async () => {
            const r = await finished(await newJob(), pass);
            expect(await service.recordPublication(r.id, { id: '99', url: 'https://github.com/o/r/pull/7#pullrequestreview-99' })).toBe(true);
            expect(await service.recordPublication(r.id, { id: '100', url: 'x' })).toBe(false);
            expect(await reviews().findOneByOrFail({ id: r.id })).toMatchObject({ publicationId: '99' });
        });
    });

    describe('routing', () => {
        it('gives concurrent routing claims one owner, also across service instances', async () => {
            const r = await finished(await newJob(), pass);
            const results = await Promise.all([service.claimRouting(r.id, 'human'), make().claimRouting(r.id, 'human'), service.claimRouting(r.id, 'human')]);
            expect(results.filter((x) => x.claimed)).toHaveLength(1);
            expect(results.find((x) => !x.claimed)).toMatchObject({ reason: 'already_claimed' });
            expect(await service.completeRouting(r.id)).toBe(true);
            expect(await service.completeRouting(r.id)).toBe(false);
            expect(await reviews().findOneByOrFail({ id: r.id })).toMatchObject({ routingState: 'done', routingAction: 'human' });
        });

        it('does not route a review that is not final', async () => {
            const r = await claimed(await newJob());
            expect(await service.claimRouting(r.id, 'human')).toMatchObject({ claimed: false });
            await service.markRunning(r.id);
            expect(await service.claimRouting(r.id, 'human')).toMatchObject({ claimed: false });
        });

        it('does not let an old result route after a head change, a closed PR or a moved-on job', async () => {
            for (const change of [{ headSha: 'sha2' }, { prNumber: 9 }, { status: 'awaiting_review' as const }, { status: 'cancelled' as const }]) {
                const job = await newJob();
                const r = await finished(job, pass);
                await jobs().update(job.id, change);
                expect(await service.claimRouting(r.id, 'human')).toEqual({ claimed: false, reason: 'stale' });
                expect((await reviews().findOneByOrFail({ id: r.id })).routingState).toBe('unclaimed');
            }
        });

        it('never routes a suppressed head', async () => {
            const r = await finished(await newJob(), pass);
            await reviews().update(r.id, { suppressed: true });
            expect((await service.claimRouting(r.id, 'human')).claimed).toBe(false);
        });

        it('takes one revision atomically, with provenance, and survives service recreation until the limit', async () => {
            const job = await newJob();
            const first = await finished(job, blocking);
            expect(await service.claimRouting(first.id, 'revision')).toEqual({ claimed: true });
            expect(await jobs().findOneByOrFail({ id: job.id })).toMatchObject({ autoReviewRevisions: 1, autoRevisionReviewId: first.id });
            expect(await make().clearPendingRevision(job.id, first.id)).toBe(true);

            for (const sha of ['sha2', 'sha3']) {
                await jobs().update(job.id, { headSha: sha });
                const next = await make().claimExecution(target(job, sha));
                if (!next.claimed) throw new Error('not claimed');
                await service.markRunning(next.review.id);
                await service.complete(next.review.id, blocking);
                const outcome = await make().claimRouting(next.review.id, 'revision');
                expect(outcome.claimed).toBe(sha === 'sha2');
                if (!outcome.claimed) expect(outcome.reason).toBe('revisions_exhausted');
            }
            // exhaustion leaves the count at the limit and the head free to be parked
            expect((await jobs().findOneByOrFail({ id: job.id })).autoReviewRevisions).toBe(2);
            const exhausted = await reviews().findOneByOrFail({ jobId: job.id, headSha: 'sha3' });
            expect(await service.claimRouting(exhausted.id, 'park')).toEqual({ claimed: true });
            expect((await service.listForJob(job.id, {})).revisionCount).toBe(2);
        });

        it('rolls the revision count back when the review claim loses', async () => {
            const job = await newJob();
            const r = await finished(job, tooLarge); // incomplete: not actionable
            expect(await service.claimRouting(r.id, 'revision')).toEqual({ claimed: false, reason: 'not_actionable' });
            expect(await jobs().findOneByOrFail({ id: job.id })).toMatchObject({ autoReviewRevisions: 0, autoRevisionReviewId: null });

            const clean = await finished(await newJob(), pass);
            expect((await service.claimRouting(clean.id, 'revision')).claimed).toBe(false);
            expect((await jobs().findOneByOrFail({ id: clean.jobId })).autoReviewRevisions).toBe(0);
        });

        it('gives concurrent revision claims one winner and one count', async () => {
            const job = await newJob();
            const r = await finished(job, blocking);
            const results = await Promise.all([service.claimRouting(r.id, 'revision'), make().claimRouting(r.id, 'revision')]);
            expect(results.filter((x) => x.claimed)).toHaveLength(1);
            expect((await jobs().findOneByOrFail({ id: job.id })).autoReviewRevisions).toBe(1);
        });
    });

    describe('restart recovery', () => {
        it('marks an execution abandoned by a previous process incomplete, without repeating it', async () => {
            const job = await newJob();
            const r = await claimed(job);
            await service.markRunning(r.id);

            const restarted = make();
            expect(await restarted.recoverOnStartup()).toBe(1);
            const row = await reviews().findOneByOrFail({ id: r.id });
            expect(row).toMatchObject({ status: 'incomplete', verdict: null, reasonCode: 'abandoned' });
            expect(await restarted.markRunning(r.id)).toBe(false);
            expect((await restarted.claimExecution(target(job))).claimed).toBe(false);
            // incomplete is never actionable: it can only go to a human
            expect(await restarted.claimRouting(r.id, 'revision')).toMatchObject({ claimed: false });
            expect(await restarted.claimRouting(r.id, 'human')).toEqual({ claimed: true });
        });

        it('leaves its own running execution and never-started pending work alone', async () => {
            const own = await claimed(await newJob());
            await service.markRunning(own.id);
            const pending = await claimed(await newJob());
            expect(await service.recoverOnStartup()).toBe(0);
            expect((await reviews().findOneByOrFail({ id: own.id })).status).toBe('running');
            expect((await reviews().findOneByOrFail({ id: pending.id })).status).toBe('pending');
            expect((await service.listPending()).map((r) => r.id)).toEqual([pending.id]);
            expect(await make().markRunning(pending.id)).toBe(true);
        });

        it('supersedes pending work whose job moved on', async () => {
            const job = await newJob();
            const r = await claimed(job);
            await jobs().update(job.id, { headSha: 'sha2' });
            expect(await make().recoverOnStartup()).toBe(1);
            expect(await reviews().findOneByOrFail({ id: r.id })).toMatchObject({ status: 'skipped', reasonCode: 'superseded' });
        });

        it('sweeps executions past their timeout plus grace, wherever they started', async () => {
            const r = await claimed(await newJob());
            await service.markRunning(r.id);
            expect(await service.sweep(new Date(Date.now() + 60_000))).toBe(0);
            expect(await service.sweep(new Date(Date.now() + 60_000 + 3 * 60_000))).toBe(1);
            expect((await reviews().findOneByOrFail({ id: r.id })).reasonCode).toBe('abandoned');
        });
    });

    describe('history', () => {
        it('paginates newest first with the revision count, links and no internals', async () => {
            const job = await newJob({ autoReviewRevisions: 1 });
            const ids: string[] = [];
            for (const sha of ['a', 'b', 'c', 'd', 'e']) {
                await jobs().update(job.id, { headSha: sha });
                job.headSha = sha;
                const r = await finished(job, sha === 'e' ? blocking : pass);
                await reviews().update(r.id, { createdAt: new Date(Date.UTC(2026, 9, 1, 10, ids.length)) });
                ids.push(r.id);
            }
            await service.recordPublication(ids[4], { id: '5', url: 'https://github.com/o/r/pull/7#pullrequestreview-5' });
            const p1 = await service.listForJob(job.id, { page: 1, pageSize: 2 });
            expect(p1).toMatchObject({ page: 1, pageSize: 2, total: 5, revisionCount: 1 });
            expect(p1.items.map((i) => i.id)).toEqual([ids[4], ids[3]]);
            expect(p1.items[0]).toMatchObject({
                status: 'complete', verdict: 'blocking', headSha: 'e', limits: LIMITS, result: blocking,
                links: { review: 'https://github.com/o/r/pull/7#pullrequestreview-5', pullRequest: 'https://github.com/o/r/pull/7' },
                routing: { state: 'unclaimed', action: null },
            });
            expect(JSON.stringify(p1)).not.toContain('claimedBy');
            expect((await service.listForJob(job.id, { page: 3, pageSize: 2 })).items.map((i) => i.id)).toEqual([ids[0]]);
        });

        it('shows pending and running reviews and survives a restart', async () => {
            const job = await newJob();
            const r = await claimed(job);
            expect((await service.listForJob(job.id, {})).items[0]).toMatchObject({ status: 'pending', result: null });
            await service.markRunning(r.id);
            expect((await make().listForJob(job.id, {})).items[0]).toMatchObject({ status: 'running', startedAt: expect.any(String) });
        });

        it('404s for an unknown job', async () => {
            await expect(service.listForJob(randomUUID(), {})).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
