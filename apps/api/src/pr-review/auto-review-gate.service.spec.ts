import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitHubPort, GitHubPull, GitHubWorkflowRun } from '../github/github.port.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';

import { AutoReviewGateService } from './auto-review-gate.service.js';
import { PrReview } from './pr-review.entity.js';
import { PrReviewService } from './pr-review.service.js';
import type { ReviewExecutionService } from './review-execution.service.js';
import type { ReviewLimits, ReviewResult } from './review-result.js';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD2 = 'ffeeddccbbaa99887766554433221100ffeeddcc';
const LIMITS: ReviewLimits = { timeoutMs: 60_000, maxSteps: 8, maxInputTokens: 100_000, maxOutputTokens: 4_000, maxRevisions: 2 };
const CI = { isCi: (n: string) => n === 'CI' };
const finding = { title: 'Divide by zero', evidence: 'a.ts:1 divides by n', path: 'a.ts', line: 1, impact: 'crash', requestedFix: 'guard n === 0' };
const finding2 = { title: 'Leak', evidence: 'b.ts:2 never closes', impact: 'leak', requestedFix: 'close the handle' };
const pass: ReviewResult = {
    kind: 'complete', verdict: 'pass', summary: 'Looks fine', inspection: { diffComplete: true, contextComplete: true },
    coverage: [], blockingFindings: [], suggestions: [],
};
const blocking: ReviewResult = { ...pass, verdict: 'blocking', blockingFindings: [finding, finding2] };
const tooLarge: ReviewResult = { kind: 'incomplete', reasonCode: 'too_large', reason: 'too large', partialFindings: [finding], suggestions: [] };

describe('AutoReviewGateService', () => {
    let ds: DataSource;
    let reviews: PrReviewService;
    let jobs: Repository<Job>;
    let projects: Repository<Project>;
    let project: Project;
    let repo: Repo;
    let outcome: ReviewResult | (() => Promise<ReviewResult>);
    let runModel: ReturnType<typeof vi.fn>;
    let execution: Pick<ReviewExecutionService, 'resolve' | 'run'>;
    let resolution: Awaited<ReturnType<ReviewExecutionService['resolve']>>;
    let pull: GitHubPull;
    let workflowRuns: GitHubWorkflowRun[];
    let github: { [K in 'getPull' | 'listWorkflowRuns' | 'publishCommentReview' | 'findReviewByMarker']: ReturnType<typeof vi.fn> } & { isConfigured: () => boolean };
    let capture: { jobAwaitingReview: ReturnType<typeof vi.fn>; jobParked: ReturnType<typeof vi.fn> };
    let gate: AutoReviewGateService;

    const build = () => new AutoReviewGateService(
        reviews, execution as ReviewExecutionService, github as unknown as GitHubPort,
        jobs, projects, ds.getRepository(Repo), ds.getRepository(JobRun), capture as never,
    );

    beforeEach(async () => {
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [PrReview, Job, User, Project, Repo, JobRun], synchronize: true }).initialize();
        jobs = ds.getRepository(Job);
        projects = ds.getRepository(Project);
        reviews = new PrReviewService(ds.getRepository(PrReview), jobs, ds);
        project = await projects.save(projects.create({ slug: 'p', name: 'P', autoReview: true, maxAttempts: 3 }));
        repo = await ds.getRepository(Repo).save(ds.getRepository(Repo).create({ projectId: project.id, fullName: 'gilde-dev/gilde', testCommands: [] }));
        outcome = pass;
        resolution = { ok: true, model: 'openai/test', limits: LIMITS };
        runModel = vi.fn(async (id: string) => {
            await reviews.markRunning(id);
            const result = typeof outcome === 'function' ? await outcome() : outcome;
            await reviews.complete(id, result);
            return { executed: true };
        });
        execution = { resolve: async () => resolution, run: runModel as never };
        pull = { number: 7, state: 'open', merged: false, headSha: HEAD, headRef: 'claude/gilde-x', htmlUrl: 'https://github.com/gilde-dev/gilde/pull/7', body: null, draft: false, baseRef: 'main', baseSha: 'base1' };
        workflowRuns = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
        github = {
            isConfigured: () => true,
            getPull: vi.fn(async () => pull),
            listWorkflowRuns: vi.fn(async () => workflowRuns),
            publishCommentReview: vi.fn(async (_r: string, _n: number, i: { commitId: string }) => ({ id: '99', htmlUrl: 'https://github.com/gilde-dev/gilde/pull/7#pullrequestreview-99', commitId: i.commitId })),
            findReviewByMarker: vi.fn(async () => null),
        };
        capture = { jobAwaitingReview: vi.fn(async () => true), jobParked: vi.fn(async () => true) };
        gate = build();
    });
    afterEach(() => ds.destroy());

    const newJob = (over: Partial<Job> = {}) => jobs.save(jobs.create({
        projectId: project.id, repoId: repo.id, title: 'Job', task: 'Do it', status: 'pr_open', prNumber: 7, headSha: HEAD, branch: 'claude/gilde-x',
        prUrl: pull.htmlUrl, attempts: 1, needsApproval: false, ...over,
    }));
    const reload = (id: string) => jobs.findOneByOrFail({ id });
    const rows = (jobId: string) => ds.getRepository(PrReview).find({ where: { jobId }, order: { createdAt: 'ASC' } });
    const green = async (job: Job, head = HEAD) => { const o = await gate.onCiPassed(job.id, head, CI); await gate.idle(); return o; };

    describe('skips keep the CI-to-human path with their own reasons', () => {
        it('moves an opted-out project straight to a human and persists project_opt_out', async () => {
            await projects.update(project.id, { autoReview: false });
            const job = await newJob();
            expect(await green(job)).toMatchObject({ routed: 'human' });
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect(await rows(job.id)).toMatchObject([{ status: 'skipped', reasonCode: 'project_opt_out', routingAction: 'human', routingState: 'done' }]);
            expect(runModel).not.toHaveBeenCalled();
            expect(github.getPull).not.toHaveBeenCalled();
            expect(capture.jobAwaitingReview).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['runtime_disabled', 'The reviewer is off'],
            ['runtime_unconfigured', 'No model'],
            ['kill_switch', 'Disabled by the environment'],
        ] as const)('configured runtime alone is not enough and %s is a distinct skip', async (reasonCode, reason) => {
            resolution = { ok: false, skip: { kind: 'skipped', reasonCode, reason } };
            const job = await newJob();
            expect(await green(job)).toMatchObject({ routed: 'human' });
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect(await rows(job.id)).toMatchObject([{ status: 'skipped', reasonCode }]);
            expect(runModel).not.toHaveBeenCalled();
        });

        it('never reviews a job that was already awaiting review (no retrospective review)', async () => {
            const job = await newJob({ status: 'awaiting_review' });
            expect(await green(job)).toMatchObject({ routed: 'none' });
            expect(await rows(job.id)).toHaveLength(0);
        });
    });

    describe('eligibility is read fresh from GitHub', () => {
        it.each([
            ['a closed PR', () => { pull = { ...pull, state: 'closed' }; }],
            ['a draft PR', () => { pull = { ...pull, draft: true }; }],
            ['a PR that moved to another head', () => { pull = { ...pull, headSha: HEAD2 }; }],
            ['CI still running on the head', () => { workflowRuns = [{ name: 'CI', status: 'in_progress', conclusion: null }, { name: 'CI', status: 'completed', conclusion: 'success' }]; }],
            ['CI failing on the head despite an older success', () => { workflowRuns = [{ name: 'CI', status: 'completed', conclusion: 'failure' }, { name: 'CI', status: 'completed', conclusion: 'success' }]; }],
            ['no visible CI run', () => { workflowRuns = []; }],
        ])('starts no review for %s', async (_name, arrange) => {
            arrange();
            const job = await newJob();
            expect(await green(job)).toMatchObject({ routed: 'none' });
            expect(await rows(job.id)).toHaveLength(0);
            expect((await reload(job.id)).status).toBe('pr_open');
            expect(runModel).not.toHaveBeenCalled();
        });

        it('stays in pr_open when GitHub cannot be read, and a later observation reviews', async () => {
            github.getPull.mockRejectedValueOnce(new Error('GitHub down'));
            const job = await newJob();
            expect(await green(job)).toMatchObject({ routed: 'none' });
            expect((await reload(job.id)).status).toBe('pr_open');
            expect(await green(job)).toMatchObject({ routed: 'pending' });
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });

        it('ignores an observation for a head the job no longer has', async () => {
            const job = await newJob({ headSha: HEAD2 });
            expect(await green(job, HEAD)).toMatchObject({ routed: 'none' });
            expect(await rows(job.id)).toHaveLength(0);
        });

        it('does not start a review for a gate-only observation: only tracked CI counts', async () => {
            workflowRuns = [{ name: 'Gates', status: 'completed', conclusion: 'success' }];
            const job = await newJob();
            expect(await green(job)).toMatchObject({ routed: 'none' });
        });
    });

    describe('clean and non-blocking results go to a human after publication', () => {
        it('publishes a head-bound COMMENT review, then moves to awaiting_review and notifies once', async () => {
            const job = await newJob();
            const order: string[] = [];
            github.publishCommentReview.mockImplementationOnce(async (_r: string, _n: number, i: { commitId: string }) => {
                order.push('publish');
                expect((await reload(job.id)).status).toBe('pr_open');
                return { id: '99', htmlUrl: 'https://x/review/99', commitId: i.commitId };
            });
            capture.jobAwaitingReview.mockImplementationOnce(async () => { order.push('notify'); return true; });
            const started = await gate.onCiPassed(job.id, HEAD, CI);
            expect(started).toEqual({ routed: 'pending' });
            // The coding run's CI is recorded, and the human is not told yet.
            expect(capture.jobAwaitingReview).not.toHaveBeenCalled();
            await gate.idle();
            expect(order).toEqual(['publish', 'notify']);
            const [row] = await rows(job.id);
            expect(row).toMatchObject({ status: 'complete', verdict: 'pass', publicationId: '99', publicationUrl: 'https://x/review/99', routingAction: 'human', routingState: 'done', headSha: HEAD });
            const call = github.publishCommentReview.mock.calls[0]!;
            expect(call[2].commitId).toBe(HEAD);
            expect(call[2].body).toContain(`gilde:pr-review:${row!.id}:${HEAD}`);
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect(capture.jobAwaitingReview.mock.calls[0]![1]).toContain('https://x/review/99');
        });

        it('treats suggestions as non-blocking', async () => {
            outcome = { ...pass, suggestions: [{ title: 'Rename', detail: 'x is unclear' }] };
            const job = await newJob();
            await green(job);
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect((await reload(job.id)).autoReviewRevisions).toBe(0);
            expect(github.publishCommentReview.mock.calls[0]![2].body).toContain('Suggestions (not blocking)');
        });

        it('keeps protected-path approval untouched', async () => {
            const job = await newJob({ needsApproval: true, approvalReason: 'Protected paths changed' });
            await green(job);
            expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review', needsApproval: true, approvalReason: 'Protected paths changed' });
        });
    });

    describe('incomplete and failed reviews never send back', () => {
        it('publishes a "too large" review as incomplete and hands the job to a human', async () => {
            outcome = tooLarge;
            const job = await newJob();
            await green(job);
            expect((await reload(job.id)).status).toBe('awaiting_review');
            const body = github.publishCommentReview.mock.calls[0]![2].body as string;
            expect(body).toContain('incomplete (not a pass)');
            expect(body).toContain('too large');
            expect((await rows(job.id))[0]).toMatchObject({ status: 'incomplete', reasonCode: 'too_large', routingAction: 'human' });
            expect((await reload(job.id)).autoReviewRevisions).toBe(0);
        });

        it.each([
            ['an execution error', { kind: 'error', reasonCode: 'execution_error', reason: 'The review failed', partialFindings: [finding], suggestions: [] } as ReviewResult],
            ['a timeout', { kind: 'incomplete', reasonCode: 'timeout', reason: 'The review ran out of time', partialFindings: [], suggestions: [] } as ReviewResult],
            ['malformed output', { kind: 'incomplete', reasonCode: 'malformed_output', reason: 'Not valid JSON', partialFindings: [], suggestions: [] } as ReviewResult],
            ['a budget refusal', { kind: 'incomplete', reasonCode: 'budget_refused', reason: 'Over budget', partialFindings: [], suggestions: [] } as ReviewResult],
        ])('routes %s to a human once and runs the model once', async (_n, result) => {
            outcome = result;
            const job = await newJob();
            await green(job);
            await green(job);
            await gate.recover(new Date(Date.now() + 3_600_000));
            await gate.idle();
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect((await reload(job.id)).autoReviewRevisions).toBe(0);
            expect(runModel).toHaveBeenCalledTimes(1);
            expect(capture.jobAwaitingReview).toHaveBeenCalledTimes(1);
        });

        it('records a publication failure as a visible error with the findings, routed to a human, never a revision', async () => {
            outcome = blocking;
            github.publishCommentReview.mockRejectedValueOnce(new Error('GitHub POST failed: 403'));
            const job = await newJob();
            await green(job);
            const [row] = await rows(job.id);
            expect(row).toMatchObject({ status: 'error', reasonCode: 'publication_failed', verdict: null, routingAction: 'human', publicationId: null });
            expect(row!.result).toMatchObject({ kind: 'error', partialFindings: [{ title: 'Divide by zero' }, { title: 'Leak' }] });
            expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review', autoReviewRevisions: 0 });
            expect(runModel).toHaveBeenCalledTimes(1);
        });

        it('recovers an uncertain publication by marker instead of posting twice', async () => {
            github.publishCommentReview.mockRejectedValue(new Error('timeout'));
            github.findReviewByMarker.mockResolvedValue({ id: '55', htmlUrl: 'https://x/review/55', commitId: HEAD });
            const job = await newJob();
            await green(job);
            const [row] = await rows(job.id);
            expect(row).toMatchObject({ status: 'complete', publicationId: '55', routingAction: 'human' });
            expect(github.publishCommentReview).not.toHaveBeenCalled();
        });
    });

    describe('blocking results return the job to the same PR', () => {
        it('atomically queues a normal attempt with every requested fix and no readiness notification', async () => {
            outcome = blocking;
            const job = await newJob();
            await green(job);
            const after = await reload(job.id);
            expect(after).toMatchObject({ status: 'queued', autoReviewRevisions: 1, prNumber: 7, branch: 'claude/gilde-x', headSha: HEAD, attempts: 1, nextRoundKind: null });
            expect(after.autoRevisionReviewId).toBe((await rows(job.id))[0]!.id);
            expect(after.lastReason).toContain('guard n === 0');
            expect(after.lastReason).toContain('close the handle');
            expect(after.lastReason).toContain('https://github.com/gilde-dev/gilde/pull/7#pullrequestreview-99');
            expect(capture.jobAwaitingReview).not.toHaveBeenCalled();
            expect((await rows(job.id))[0]).toMatchObject({ routingAction: 'revision', routingState: 'done' });
        });

        it('does not send the same head back twice on duplicate observations, worker passes or restarts', async () => {
            outcome = blocking;
            const job = await newJob();
            await Promise.all([gate.onCiPassed(job.id, HEAD, CI), gate.onCiPassed(job.id, HEAD, CI), gate.onCiPassed(job.id, HEAD, CI)]);
            await gate.idle();
            const restarted = build();
            await restarted.recover(new Date(Date.now() + 3_600_000));
            await restarted.idle();
            expect(runModel).toHaveBeenCalledTimes(1);
            expect(await rows(job.id)).toHaveLength(1);
            expect((await reload(job.id)).autoReviewRevisions).toBe(1);
        });

        it('parks with the findings when the reviewer revision limit is reached, counted across heads', async () => {
            outcome = blocking;
            const job = await newJob({ autoReviewRevisions: 2 });
            await green(job);
            const after = await reload(job.id);
            expect(after.status).toBe('parked');
            expect(after.autoReviewRevisions).toBe(2);
            expect(after.lastReason).toContain('limit of automatic review revisions');
            expect(after.lastReason).toContain('guard n === 0');
            expect(capture.jobParked).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), expect.stringContaining('revisions'), 'auto_review');
            expect(capture.jobAwaitingReview).not.toHaveBeenCalled();
        });

        it('stops after the default of two revisions over successive heads', async () => {
            outcome = blocking;
            const job = await newJob();
            await green(job);
            expect((await reload(job.id)).status).toBe('queued');
            // The agent pushes a fix: the next head is reviewed, and so on.
            await jobs.update(job.id, { status: 'pr_open', headSha: HEAD2 });
            pull = { ...pull, headSha: HEAD2 };
            await green(job, HEAD2);
            expect((await reload(job.id))).toMatchObject({ status: 'queued', autoReviewRevisions: 2 });
            await jobs.update(job.id, { status: 'pr_open', headSha: 'c'.repeat(40) });
            pull = { ...pull, headSha: 'c'.repeat(40) };
            await green(job, 'c'.repeat(40));
            expect((await reload(job.id))).toMatchObject({ status: 'parked', autoReviewRevisions: 2 });
        });

        it('parks when the project attempts are used up and takes no revision', async () => {
            outcome = blocking;
            const job = await newJob({ attempts: 3 });
            await green(job);
            const after = await reload(job.id);
            expect(after).toMatchObject({ status: 'parked', autoReviewRevisions: 0 });
            expect(after.lastReason).toContain('used all its attempts');
            expect(after.lastReason).toContain('close the handle');
        });

        it('honours a custom reviewer revision limit from the snapshot', async () => {
            outcome = blocking;
            resolution = { ok: true, model: 'm', limits: { ...LIMITS, maxRevisions: 1 } };
            const job = await newJob({ autoReviewRevisions: 1 });
            await green(job);
            expect((await reload(job.id)).status).toBe('parked');
        });
    });

    describe('stale results never route', () => {
        it('drops a result whose head changed during the model run', async () => {
            outcome = async () => { await jobs.update({ headSha: HEAD }, { headSha: HEAD2 }); return blocking; };
            const job = await newJob();
            await green(job);
            expect(await reload(job.id)).toMatchObject({ status: 'pr_open', headSha: HEAD2, autoReviewRevisions: 0 });
            expect((await rows(job.id))[0]).toMatchObject({ status: 'complete', routingState: 'unclaimed' });
            expect(github.publishCommentReview).not.toHaveBeenCalled();
            expect(capture.jobAwaitingReview).not.toHaveBeenCalled();
        });

        it('drops a result when CI failed and requeued the job meanwhile', async () => {
            outcome = async () => { await jobs.update({ id: (await jobs.find())[0]!.id }, { status: 'queued' }); return pass; };
            const job = await newJob();
            await green(job);
            expect((await reload(job.id)).status).toBe('queued');
            expect(capture.jobAwaitingReview).not.toHaveBeenCalled();
        });

        it('does not route a head-scoped suppressed (overridden) review', async () => {
            outcome = async () => { await ds.getRepository(PrReview).update({}, { suppressed: true }); return blocking; };
            const job = await newJob();
            await green(job);
            expect(await reload(job.id)).toMatchObject({ status: 'pr_open', autoReviewRevisions: 0 });
        });

        it('lets a new head start a fresh review while the old result stays history', async () => {
            const job = await newJob();
            await green(job);
            await jobs.update(job.id, { status: 'pr_open', headSha: HEAD2 });
            pull = { ...pull, headSha: HEAD2 };
            await green(job, HEAD2);
            expect(await rows(job.id)).toHaveLength(2);
            expect(runModel).toHaveBeenCalledTimes(2);
        });
    });

    describe('restart recovery', () => {
        it('starts a claimed review whose process died before running it, exactly once', async () => {
            const job = await newJob();
            const claim = await reviews.claimExecution({ jobId: job.id, prNumber: 7, headSha: HEAD, limits: LIMITS });
            expect(claim.claimed).toBe(true);
            expect(await gate.recover()).toBe(0); // too young: probably in flight
            const restarted = build();
            expect(await restarted.recover(new Date(Date.now() + 3_600_000))).toBe(1);
            await restarted.idle();
            expect(runModel).toHaveBeenCalledTimes(1);
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });

        it('routes a final result that was never routed, without another model call', async () => {
            const job = await newJob();
            const claim = await reviews.claimExecution({ jobId: job.id, prNumber: 7, headSha: HEAD, limits: LIMITS });
            if (!claim.claimed) throw new Error('claim');
            await reviews.markRunning(claim.review.id);
            await reviews.complete(claim.review.id, blocking);
            await build().recover(new Date(Date.now() + 3_600_000));
            const g = build();
            await g.recover(new Date(Date.now() + 3_600_000));
            await g.idle();
            expect(runModel).not.toHaveBeenCalled();
            expect(await reload(job.id)).toMatchObject({ status: 'queued', autoReviewRevisions: 1 });
        });
    });
});
