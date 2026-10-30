import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitHubPort, GitHubPull, GitHubWorkflowRun } from '../github/github.port.js';
import { JobEventsService } from '../job/job-events.service.js';
import type { JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { Feature } from '../feature/feature.entity.js';
import { Notification } from '../notification/notification.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import { ReconcilerService, syncIneligibleReason } from './reconciler.service.js';

const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'ffeeddccbbaa99887766554433221100ffeeddcc';

let ds: DataSource;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let projects: Repository<Project>;
let repo: Repo;
let github: GitHubPort & { pulls: Map<number, GitHubPull>; recent: GitHubPull[]; workflows: GitHubWorkflowRun[]; fail: Partial<Record<string, Error>> };
let service: ReconcilerService;
const onJobEnded = vi.fn(async () => undefined);
const featureReadiness = vi.fn(async () => undefined);

beforeEach(async () => {
    onJobEnded.mockClear();
    featureReadiness.mockClear();
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, Feature, Notification], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    projects = ds.getRepository(Project);
    const project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
    repo = await ds.getRepository(Repo).save(
        ds.getRepository(Repo).create({ projectId: project.id, fullName: 'gilde-dev/gilde', testCommands: ['pnpm test'] }),
    );
    const throwIfFailing = (method: string) => {
        const err = github.fail[method];
        if (err) throw err;
    };
    github = {
        pulls: new Map(), recent: [], workflows: [], fail: {},
        isConfigured: () => true,
        getPull: async (_f, n) => { throwIfFailing('getPull'); return github.pulls.get(n)!; },
        listRecentPulls: async () => { throwIfFailing('listRecentPulls'); return github.recent; },
        listWorkflowRuns: async () => { throwIfFailing('listWorkflowRuns'); return github.workflows; },
        getBranchHeadSha: async () => 'sha',
        getFileContent: async () => null,
        listDirectory: async () => null,
        listOpenIssuesWithLabel: async () => ({ issues: [], complete: true }),
    };
    const events = new JobEventsService(
        jobs, runs, projects, { onJobEnded } as never, undefined, undefined, { featureReadiness, operatorActions: vi.fn(async () => undefined), jobAwaitingReview: vi.fn(async () => undefined), jobParked: vi.fn(async () => undefined) } as never,
    );
    service = new ReconcilerService(github, events, jobs, ds.getRepository(Repo), projects, runs);
});

afterEach(() => ds.destroy());

const seedJob = (status: JobStatus, over: Partial<Job> = {}) => jobs.save(jobs.create({
    projectId: repo.projectId, repoId: repo.id, title: 'T', task: 'do', status, queuedAt: new Date(), attempts: 1, ...over,
}));
const prJob = (status: JobStatus, over: Partial<Job> = {}) => seedJob(status, { prNumber: 12, prUrl: 'u', branch: 'b', headSha: SHA1, ...over });
const reload = (id: string) => jobs.findOneByOrFail({ id });
const pull = (over: Partial<GitHubPull> = {}): GitHubPull => ({
    number: 12, state: 'open', merged: false, headSha: SHA1, headRef: 'b', htmlUrl: 'https://github.com/gilde-dev/gilde/pull/12', body: null, ...over,
});
const completed = (name: string, conclusion: string): GitHubWorkflowRun => ({ name, status: 'completed', conclusion });

describe('ReconcilerService.syncJob', () => {
    it('applies a missed merge with its effects once', async () => {
        const job = await prJob('awaiting_review');
        github.pulls.set(12, pull({ state: 'closed', merged: true }));

        const res = await service.syncJob(job.id);
        expect(res).toMatchObject({
            jobId: job.id,
            pr: { number: 12, state: 'closed', merged: true, headSha: SHA1 },
            before: { status: 'awaiting_review', prNumber: 12 },
            after: { status: 'merged' },
            changes: ['PR #12 merged'],
        });
        expect(onJobEnded).toHaveBeenCalledTimes(1);
        expect(featureReadiness).toHaveBeenCalledTimes(1);

        const again = await service.syncJob(job.id);
        expect(again.changes).toEqual([]);
        expect(onJobEnded).toHaveBeenCalledTimes(1);
        expect(featureReadiness).toHaveBeenCalledTimes(1);
    });

    it('overlapping syncs and a scheduled pass apply the merge once', async () => {
        const job = await prJob('awaiting_review');
        github.pulls.set(12, pull({ state: 'closed', merged: true }));
        await Promise.all([service.syncJob(job.id), service.syncJob(job.id), service.reconcile()]);
        expect((await reload(job.id)).status).toBe('merged');
        expect(onJobEnded).toHaveBeenCalledTimes(1);
    });

    it('applies a closed unmerged PR as rejected', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull({ state: 'closed' }));
        const res = await service.syncJob(job.id);
        expect(res.after.status).toBe('rejected');
        expect(res.changes).toEqual(['PR #12 closed']);
        expect(onJobEnded).toHaveBeenCalledWith(job.id, 'rejected');
    });

    it('reports an open PR as unchanged, and a reopened PR on a rejected job leaves it rejected', async () => {
        const open = await prJob('awaiting_review');
        github.pulls.set(12, pull());
        const res = await service.syncJob(open.id);
        expect(res).toMatchObject({ pr: { state: 'open' }, changes: [], ciConclusion: null });
        expect(res.before).toEqual(res.after);

        const rejected = await prJob('rejected', { prNumber: 13 });
        github.pulls.set(13, pull({ number: 13 }));
        const r2 = await service.syncJob(rejected.id);
        expect(r2.changes).toEqual([]);
        expect((await reload(rejected.id)).status).toBe('rejected');
    });

    it('applies CI success and failure', async () => {
        const ok = await prJob('pr_open');
        github.pulls.set(12, pull());
        github.workflows = [completed('CI', 'success')];
        const res = await service.syncJob(ok.id);
        expect(res).toMatchObject({ after: { status: 'awaiting_review' }, ciConclusion: 'success' });
        expect(res.changes).toContain('workflow CI success');

        await jobs.update({ id: ok.id }, { status: 'pr_open' });
        github.workflows = [completed('CI', 'failure')];
        const bad = await service.syncJob(ok.id);
        expect(bad).toMatchObject({ after: { status: 'queued' }, ciConclusion: 'failure' });
    });

    it('finds the PR of a dispatched job by branch, even without a marker', async () => {
        const job = await seedJob('dispatched', { branch: 'claude/gilde-x' });
        github.recent = [pull({ number: 3, headRef: 'other' }), pull({ headRef: 'claude/gilde-x' })];
        const res = await service.syncJob(job.id);
        expect(res).toMatchObject({ pr: { number: 12 }, after: { status: 'pr_open', prNumber: 12 } });
    });

    it('does not take a PR that carries another job\'s marker', async () => {
        const job = await seedJob('dispatched', { branch: 'claude/gilde-x' });
        github.recent = [pull({ headRef: 'claude/gilde-x', body: 'gilde-job: 11111111-1111-4111-8111-111111111111' })];
        expect((await service.syncJob(job.id)).pr).toBeNull();
    });

    it('returns an unchanged result with pr null when no PR exists on the branch', async () => {
        const job = await seedJob('dispatched');
        const res = await service.syncJob(job.id);
        expect(res).toMatchObject({ pr: null, changes: [] });
        expect(res.before).toEqual(res.after);
    });

    it('keeps mergedBlocked set and does not replay effects on terminal rechecks', async () => {
        const job = await prJob('awaiting_review');
        await runs.save(runs.create({ jobId: job.id, projectId: repo.projectId, repoId: repo.id, attempt: 1, status: 'pr_opened', result: { outcome: 'blocked', summary: 'x' } } as never));
        github.pulls.set(12, pull({ state: 'closed', merged: true }));
        await service.syncJob(job.id);
        expect(await reload(job.id)).toMatchObject({ status: 'merged', mergedBlocked: true });

        await service.syncJob(job.id);
        expect(await reload(job.id)).toMatchObject({ status: 'merged', mergedBlocked: true });
        expect(onJobEnded).toHaveBeenCalledTimes(1);
    });

    it('refreshes only the CI conclusion of a merged job', async () => {
        const job = await prJob('merged');
        const run = await runs.save(runs.create({ jobId: job.id, projectId: repo.projectId, repoId: repo.id, attempt: 1, status: 'pr_opened' } as never));
        github.pulls.set(12, pull({ state: 'closed', merged: true }));
        github.workflows = [completed('CI', 'success')];
        const res = await service.syncJob(job.id);
        expect(res).toMatchObject({ ciConclusion: 'success', changes: ['CI success recorded for the latest run'], before: { status: 'merged' }, after: { status: 'merged' } });
        expect((await runs.findOneByOrFail({ id: run.id })).ciConclusion).toBe('success');
        expect(onJobEnded).not.toHaveBeenCalled();
        expect(featureReadiness).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown job and 409 for ineligible ones', async () => {
        await expect(service.syncJob('11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(NotFoundException);
        for (const status of ['triage', 'queued', 'cancelled'] as const) {
            const job = await seedJob(status);
            await expect(service.syncJob(job.id)).rejects.toBeInstanceOf(ConflictException);
        }
        for (const status of ['parked', 'rejected', 'merged'] as const) {
            await expect(service.syncJob((await seedJob(status)).id)).rejects.toThrow(/without a PR/);
        }
        expect(syncIneligibleReason({ status: 'parked', prNumber: 3 })).toBeNull();
    });

    describe('GitHub failures', () => {
        const cases: [string, Error, RegExp][] = [
            ['not installed', new Error('the Gilde GitHub App is not installed on gilde-dev/gilde'), /not installed/],
            ['rejected installation token', new Error('GitHub POST /app/installations/:id/access_tokens failed: 401'), /401/],
            ['403', new Error('GitHub GET /repos/gilde-dev/gilde/pulls/12 failed: 403'), /403/],
            ['404', new Error('GitHub GET /repos/gilde-dev/gilde/pulls/12 failed: 404'), /404/],
            ['rate limit', new Error('GitHub GET /repos/x/y/pulls/12 failed: 429'), /rate limit/],
            ['network', new Error('fetch failed: token ghs_SECRET'), /could not be reached/],
        ];
        it.each(cases)('%s gives a safe 502 and no mutation', async (_n, err, expected) => {
            const job = await prJob('awaiting_review');
            github.pulls.set(12, pull({ state: 'closed', merged: true }));
            github.fail.getPull = err;
            const e = await service.syncJob(job.id).catch((x: unknown) => x);
            expect(e).toBeInstanceOf(BadGatewayException);
            const message = (e as BadGatewayException).message;
            expect(message).toContain('gilde-dev/gilde');
            expect(message).toMatch(expected);
            expect(message).not.toContain('SECRET');
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect(onJobEnded).not.toHaveBeenCalled();
        });

        it('a later failing read (workflow runs) leaves the job untouched', async () => {
            const job = await prJob('pr_open', { headSha: SHA2 });
            github.pulls.set(12, pull());
            github.fail.listWorkflowRuns = new Error('GitHub GET /repos/a/b/actions/runs failed: 500');
            await expect(service.syncJob(job.id)).rejects.toBeInstanceOf(BadGatewayException);
            expect(await reload(job.id)).toMatchObject({ status: 'pr_open', headSha: SHA2 });
        });

        it('a failing branch lookup is a 502, unlike an empty one', async () => {
            const job = await seedJob('dispatched');
            github.fail.listRecentPulls = new Error('GitHub GET /repos/a/b/pulls failed: 500');
            await expect(service.syncJob(job.id)).rejects.toBeInstanceOf(BadGatewayException);
        });
    });
});

describe('ReconcilerService.reconcileProject', () => {
    it('only touches the jobs of that project', async () => {
        const other = await projects.save(projects.create({ slug: 'q', name: 'Q' }));
        const otherRepo = await ds.getRepository(Repo).save(ds.getRepository(Repo).create({ projectId: other.id, fullName: 'gilde-dev/other', testCommands: ['t'] }));
        const mine = await prJob('awaiting_review');
        const theirs = await prJob('awaiting_review', { projectId: other.id, repoId: otherRepo.id });
        github.pulls.set(12, pull({ state: 'closed', merged: true }));

        expect(await service.reconcileProject(repo.projectId)).toEqual({ checked: 1, corrected: 1 });
        expect((await reload(mine.id)).status).toBe('merged');
        expect((await reload(theirs.id)).status).toBe('awaiting_review');
    });

    it('404 for an unknown project', async () => {
        await expect(service.reconcileProject('11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(NotFoundException);
    });
});
