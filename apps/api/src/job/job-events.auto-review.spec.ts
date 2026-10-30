import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitHubPort } from '../github/github.port.js';
import { AutoReviewGateService } from '../pr-review/auto-review-gate.service.js';
import { PrReview } from '../pr-review/pr-review.entity.js';
import { PrReviewService } from '../pr-review/pr-review.service.js';
import type { ReviewExecutionService } from '../pr-review/review-execution.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';

import { JobEventsService } from './job-events.service.js';
import { Job } from './job.entity.js';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const LIMITS = { timeoutMs: 60_000, maxSteps: 8, maxInputTokens: 100_000, maxOutputTokens: 4_000, maxRevisions: 2 };

describe('JobEventsService with the automatic review gate', () => {
    let ds: DataSource;
    let events: JobEventsService;
    let project: Project;
    let job: Job;
    let ciRuns: { name: string; status: string; conclusion: string | null }[];
    let model: ReturnType<typeof vi.fn>;
    let gate: AutoReviewGateService;

    beforeEach(async () => {
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [PrReview, Job, User, Project, Repo, JobRun], synchronize: true }).initialize();
        const reviews = new PrReviewService(ds.getRepository(PrReview), ds.getRepository(Job), ds);
        project = await ds.getRepository(Project).save(ds.getRepository(Project).create({ slug: 'p', name: 'P', autoReview: true }));
        const repo = await ds.getRepository(Repo).save(ds.getRepository(Repo).create({ projectId: project.id, fullName: 'o/r', testCommands: [] }));
        job = await ds.getRepository(Job).save(ds.getRepository(Job).create({ projectId: project.id, repoId: repo.id, title: 'J', task: 't', status: 'pr_open', prNumber: 3, headSha: HEAD, attempts: 1 }));
        ciRuns = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
        model = vi.fn(async (id: string) => {
            await reviews.markRunning(id);
            await reviews.complete(id, { kind: 'complete', verdict: 'pass', summary: 'ok', inspection: { diffComplete: true, contextComplete: true }, coverage: [], blockingFindings: [], suggestions: [] });
        });
        const github = {
            getPull: async () => ({ number: 3, state: 'open', merged: false, headSha: HEAD, headRef: 'b', htmlUrl: 'u', body: null, draft: false }),
            listWorkflowRuns: async () => ciRuns,
            publishCommentReview: async () => ({ id: '1', htmlUrl: 'https://x/r/1', commitId: HEAD }),
            findReviewByMarker: async () => null,
        } as unknown as GitHubPort;
        const execution = { resolve: async () => ({ ok: true, model: 'm', limits: LIMITS }), run: model } as unknown as ReviewExecutionService;
        gate = new AutoReviewGateService(reviews, execution, github, ds.getRepository(Job), ds.getRepository(Project), ds.getRepository(Repo), ds.getRepository(JobRun));
        events = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), undefined, undefined, undefined, undefined, undefined, undefined, gate);
    });
    afterEach(() => ds.destroy());

    const status = async () => (await ds.getRepository(Job).findOneByOrFail({ id: job.id })).status;

    it('keeps the job in pr_open while the review of an opted-in project runs, then hands it to a human', async () => {
        const res = await events.workflowCompleted(job, 3, { name: 'CI', conclusion: 'success', headSha: HEAD });
        expect(res).toContain('automatic review pending');
        expect(await status()).toBe('pr_open');
        await gate.idle();
        expect(await status()).toBe('awaiting_review');
    });

    it('does not start a review for a repeated success observation', async () => {
        await events.workflowCompleted(job, 3, { name: 'CI', conclusion: 'success', headSha: HEAD });
        await events.workflowCompleted(job, 3, { name: 'CI', conclusion: 'success', headSha: HEAD });
        await gate.idle();
        expect(model).toHaveBeenCalledTimes(1);
    });

    it('never lets one stale success win over a current failing run', async () => {
        ciRuns = [{ name: 'CI', status: 'completed', conclusion: 'failure' }, { name: 'CI', status: 'completed', conclusion: 'success' }];
        await events.workflowCompleted(job, 3, { name: 'CI', conclusion: 'success', headSha: HEAD });
        await gate.idle();
        expect(model).not.toHaveBeenCalled();
        expect(await status()).toBe('pr_open');
    });

    it('keeps the CI-to-human path for an opted-out project', async () => {
        await ds.getRepository(Project).update(project.id, { autoReview: false });
        const res = await events.workflowCompleted(job, 3, { name: 'CI', conclusion: 'success', headSha: HEAD });
        expect(res).toBe('job awaiting_review with PR #3');
        expect(model).not.toHaveBeenCalled();
    });

    it('still retries on failing CI without a review', async () => {
        await events.workflowCompleted(job, 3, { name: 'CI', conclusion: 'failure', headSha: HEAD });
        expect(await status()).toBe('queued');
        expect(model).not.toHaveBeenCalled();
    });
});
