import { DataSource, type Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobStatus } from '../job/job-state.js';
import { User } from '../user/user.entity.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import type { RepoService } from '../repo/repo.service.js';
import { Feedback } from '../feedback/feedback.entity.js';
import { FeedbackMapper } from '../feedback/feedback.mapper.js';
import { FeedbackService } from '../feedback/feedback.service.js';
import { JobRun } from '../run/run.entity.js';
import { Feature } from '../feature/feature.entity.js';
import { JobEventsService } from '../job/job-events.service.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { NotificationMapper } from '../notification/notification.mapper.js';
import { Notification } from '../notification/notification.entity.js';
import { NotificationService } from '../notification/notification.service.js';
import { WebhookService } from './webhook.service.js';

const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'ffeeddccbbaa99887766554433221100ffeeddcc';

let ds: DataSource;
let projects: Repository<Project>;
let repos: Repository<Repo>;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let service: WebhookService;
let feedbackService: FeedbackService;
let repo: Repo;
let notifications: Repository<Notification>;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, Feedback, Feature, Notification], synchronize: true,
    }).initialize();
    projects = ds.getRepository(Project);
    repos = ds.getRepository(Repo);
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    const project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
    repo = await repos.save(repos.create({ projectId: project.id, fullName: 'gilde-dev/gilde', testCommands: ['pnpm test'] }));
    const repoService = {
        findByFullName: (n: string) => repos.findOneBy({ fullName: n.toLowerCase() }),
    } as unknown as RepoService;
    feedbackService = new FeedbackService(new FeedbackMapper(), ds.getRepository(Feedback));
    notifications = ds.getRepository(Notification);
    const capture = new NotificationCaptureService(
        new NotificationService(notifications, new NotificationMapper()), repos, jobs, ds.getRepository(Feature),
    );
    const events = new JobEventsService(jobs, runs, projects, undefined, undefined, undefined, capture);
    service = new WebhookService(repoService, feedbackService, jobs, runs, projects, events);
});

afterEach(() => ds.destroy());

async function seedJob(status: JobStatus = 'dispatched', over: Partial<Job> = {}) {
    return jobs.save(jobs.create({
        projectId: repo.projectId, repoId: repo.id, title: 'T', task: 'do', status, queuedAt: new Date(), attempts: 1, ...over,
    }));
}
async function seedRun(job: Job, attempt = 1) {
    return runs.save(runs.create({
        jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt, status: 'fired',
    }));
}
const reload = (id: string) => jobs.findOneByOrFail({ id });
const reloadRun = (id: string) => runs.findOneByOrFail({ id });

function body(job: Job, run: JobRun | null, summary = 'did it') {
    return [
        'Added the thing.',
        '',
        `gilde-job: ${job.id}`,
        run ? `gilde-run: ${run.id}` : '',
        '',
        '```gilde-result',
        JSON.stringify({ outcome: 'done', summary, testsRun: true, testsPassed: true, suggestedLesson: null }),
        '```',
        '',
        '## Retro',
        '- What I changed: stuff',
    ].join('\n');
}

function prPayload(action: string, over: Record<string, unknown> = {}, repoName = 'Gilde-dev/gilde') {
    return {
        action,
        number: 12,
        repository: { full_name: repoName },
        pull_request: {
            number: 12,
            html_url: 'https://github.com/gilde-dev/gilde/pull/12',
            state: 'open',
            merged: false,
            body: null,
            head: { ref: 'claude/gilde-abcd1234', sha: SHA1 },
            base: { ref: 'main' },
            ...over,
        },
    };
}

function runPayload(over: Record<string, unknown> = {}) {
    return {
        action: 'completed',
        repository: { full_name: 'gilde-dev/gilde' },
        workflow_run: {
            id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: SHA1,
            pull_requests: [{ number: 12 }], ...over,
        },
    };
}

describe('WebhookService', () => {
    it('ignores events it does not handle', async () => {
        expect(await service.handle('push', {})).toBe('ignored: event push');
    });

    it('ignores deliveries for unknown repos', async () => {
        const job = await seedJob();
        const res = await service.handle('pull_request', prPayload('opened', { body: body(job, null) }, 'other/repo'));
        expect(res).toBe('ignored: unknown repo other/repo');
        expect((await reload(job.id)).status).toBe('dispatched');
    });

    describe('opened', () => {
        it('moves the job to pr_open and records the PR and the run result', async () => {
            const job = await seedJob();
            const run = await seedRun(job);
            const res = await service.handle('pull_request', prPayload('opened', { body: body(job, run) }));
            expect(res).toBe('job pr_open with PR #12');
            expect(await reload(job.id)).toMatchObject({
                status: 'pr_open', prNumber: 12, prUrl: 'https://github.com/gilde-dev/gilde/pull/12',
                branch: 'claude/gilde-abcd1234', headSha: SHA1,
            });
            expect(await reloadRun(run.id)).toMatchObject({
                status: 'pr_opened', result: { outcome: 'done', summary: 'did it' }, resultError: null,
                retro: '- What I changed: stuff',
            });
        });

        it('falls back to the latest run without a gilde-run marker, and stores a result error', async () => {
            const job = await seedJob();
            await seedRun(job, 1);
            const run2 = await seedRun(job, 2);
            await service.handle('pull_request', prPayload('ready_for_review', { body: `gilde-job: ${job.id}` }));
            expect(await reloadRun(run2.id)).toMatchObject({
                status: 'pr_opened', result: null, resultError: 'missing gilde-result block',
            });
        });

        it('ignores a PR without a marker', async () => {
            const job = await seedJob();
            const res = await service.handle('pull_request', prPayload('opened', { body: 'just a PR' }));
            expect(res).toBe('ignored: PR #12 has no gilde-job marker');
            expect((await reload(job.id)).status).toBe('dispatched');
        });

        it('ignores a marker for a job of another repo or an unknown job', async () => {
            const other = await repos.save(repos.create({ projectId: repo.projectId, fullName: 'o/other', testCommands: ['x'] }));
            const job = await seedJob('dispatched', { repoId: other.id });
            expect(await service.handle('pull_request', prPayload('opened', { body: body(job, null) })))
                .toBe('ignored: PR #12 references unknown job');
        });

        it('ignores a terminal job', async () => {
            const job = await seedJob('cancelled');
            const res = await service.handle('pull_request', prPayload('opened', { body: body(job, null) }));
            expect(res).toBe('ignored: job is cancelled');
        });

        it('ignores a PR when the job already has a different PR', async () => {
            const job = await seedJob('pr_open', { prNumber: 7, headSha: SHA1 });
            const res = await service.handle('pull_request', prPayload('opened', { body: body(job, null) }));
            expect(res).toBe('ignored: job already has PR #7');
            expect((await reload(job.id)).prNumber).toBe(7);
        });

        it('is harmless when redelivered after CI passed', async () => {
            const job = await seedJob();
            const run = await seedRun(job);
            const payload = prPayload('opened', { body: body(job, run) });
            await service.handle('pull_request', payload);
            await service.handle('workflow_run', runPayload());
            expect((await reload(job.id)).status).toBe('awaiting_review');

            expect(await service.handle('pull_request', payload)).toBe('unchanged: job awaiting_review with PR #12');
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect((await reloadRun(run.id)).status).toBe('ci_passed');
        });
    });

    describe('synchronize', () => {
        it('updates the head sha and sends the job back to pr_open', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            const res = await service.handle('pull_request', prPayload('synchronize', { head: { ref: 'b', sha: SHA2 } }));
            expect(res).toBe('job pr_open with PR #12');
            expect(await reload(job.id)).toMatchObject({ status: 'pr_open', headSha: SHA2 });
        });

        it('ignores a redelivered synchronize and unknown PRs', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA2 });
            await service.handle('pull_request', prPayload('synchronize', { head: { ref: 'b', sha: SHA2 } }));
            expect((await reload(job.id)).status).toBe('awaiting_review');
            expect(await service.handle('pull_request', prPayload('synchronize', { number: 99 })))
                .toContain('ignored');
        });
    });

    describe('edited', () => {
        it('re-parses the body onto the latest run', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            await seedRun(job, 1);
            const run2 = await seedRun(job, 2);
            await service.handle('pull_request', prPayload('edited', { body: body(job, run2, 'edited summary') }));
            expect(await reloadRun(run2.id)).toMatchObject({
                result: { summary: 'edited summary' }, retro: '- What I changed: stuff',
            });
        });

        it('links an unlinked PR once the marker is added', async () => {
            const job = await seedJob();
            const run = await seedRun(job);
            expect(await service.handle('pull_request', prPayload('opened'))).toBe('ignored: PR #12 has no gilde-job marker');
            const res = await service.handle('pull_request', prPayload('edited', { body: body(job, run) }));
            expect(res).toBe('job pr_open with PR #12');
            expect(await reload(job.id)).toMatchObject({ status: 'pr_open', prNumber: 12, headSha: SHA1 });
            expect(await reloadRun(run.id)).toMatchObject({ status: 'pr_opened', result: { outcome: 'done' } });
        });

        it('only updates the run result on an already-linked PR', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            const run = await seedRun(job);
            const res = await service.handle('pull_request', prPayload('edited', { body: body(job, run) }));
            expect(res).toBe('updated result of run 1 for PR #12');
            expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review' });
            expect(await reloadRun(run.id)).toMatchObject({ result: { outcome: 'done' } });
        });

        it('ignores an unlinked PR whose job is terminal', async () => {
            const job = await seedJob('merged');
            const res = await service.handle('pull_request', prPayload('edited', { body: body(job, null) }));
            expect(res).toBe('ignored: job is merged');
            expect(await reload(job.id)).toMatchObject({ status: 'merged', prNumber: null });
        });
    });

    describe('workflow_run', () => {
        it.each(['success', 'neutral', 'skipped'])('moves the job to awaiting_review on %s', async (conclusion) => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            const run = await seedRun(job);
            const res = await service.handle('workflow_run', runPayload({ conclusion }));
            expect(res).toBe('job awaiting_review with PR #12');
            expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review' });
            expect(await reloadRun(run.id)).toMatchObject({ status: 'ci_passed', ciConclusion: conclusion });
        });

        it('requeues the job on failure when attempts are left, keeping the PR', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, branch: 'claude/x', headSha: SHA1 });
            const run = await seedRun(job);
            await service.handle('workflow_run', runPayload({ conclusion: 'failure' }));
            expect(await reload(job.id)).toMatchObject({
                status: 'queued', prNumber: 12, branch: 'claude/x', headSha: SHA1,
                lastReason: 'CI failure on a1b2c3d. Fix the failing checks on the existing branch.',
            });
            expect(await reloadRun(run.id)).toMatchObject({ status: 'ci_failed', ciConclusion: 'failure' });
        });

        it('parks the job on failure when no attempts are left', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1, attempts: 3 });
            await service.handle('workflow_run', runPayload({ conclusion: 'failure' }));
            expect(await reload(job.id)).toMatchObject({
                status: 'parked', lastReason: 'CI failure on a1b2c3d. Fix the failing checks on the existing branch.',
            });
        });

        it('ignores a stale workflow run', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA2 });
            const res = await service.handle('workflow_run', runPayload({ conclusion: 'failure' }));
            expect(res).toBe('ignored: stale workflow_run a1b2c3d for PR #12');
            expect((await reload(job.id)).status).toBe('pr_open');
        });

        it('ignores unknown workflow names, unfinished runs and unknown PRs', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            expect(await service.handle('workflow_run', runPayload({ name: 'Other', conclusion: 'failure' })))
                .toBe('ignored: workflow Other is not configured');
            expect(await service.handle('workflow_run', { ...runPayload(), action: 'requested' })).toContain('ignored');
            expect(await service.handle('workflow_run', runPayload({ pull_requests: [{ number: 99 }] }))).toContain('ignored');
            expect((await reload(job.id)).status).toBe('pr_open');
        });

        it('ends a job mid-retry as merged and supersedes the active run', async () => {
            const job = await seedJob('dispatched', { prNumber: 12, headSha: SHA1, attempts: 2 });
            const old = await seedRun(job, 1);
            await runs.update({ id: old.id }, { status: 'ci_failed' });
            const active = await seedRun(job, 2);
            const res = await service.handle('pull_request', prPayload('closed', { merged: true }));
            expect(res).toBe('job merged with PR #12');
            expect((await reload(job.id)).status).toBe('merged');
            expect((await reloadRun(active.id)).status).toBe('superseded');
            expect((await reloadRun(old.id)).status).toBe('ci_failed');
        });

        it('ignores check_suite deliveries', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            const res = await service.handle('check_suite', {
                action: 'completed', repository: { full_name: 'gilde-dev/gilde' },
                check_suite: { conclusion: 'failure', head_sha: SHA1, pull_requests: [{ number: 12 }] },
            } as never);
            expect(res).toBe('ignored: check_suite deliveries are not used; decisions come from workflow_run');
            expect((await reload(job.id)).status).toBe('pr_open');
        });

        describe('Gates', () => {
            const REASON = 'Protected paths changed; add the gilde:allow-protected label if intended';

            it('flags a failing gate without requeueing or consuming an attempt', async () => {
                const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
                const run = await seedRun(job);
                const res = await service.handle('workflow_run', runPayload({ name: 'Gates', conclusion: 'failure' }));
                expect(res).toBe('gate failed: job pr_open needs approval for PR #12');
                expect(await reload(job.id)).toMatchObject({
                    status: 'pr_open', attempts: 1, needsApproval: true, approvalReason: REASON, lastReason: null,
                });
                expect((await reloadRun(run.id)).status).toBe('fired');
            });

            it('clears the flag on a passing gate', async () => {
                const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1, needsApproval: true, approvalReason: REASON });
                await service.handle('workflow_run', runPayload({ name: 'Gates', conclusion: 'success' }));
                expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review', needsApproval: false, approvalReason: null });
            });

            it('ignores a stale gate run', async () => {
                const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA2 });
                await service.handle('workflow_run', runPayload({ name: 'Gates', conclusion: 'failure' }));
                expect((await reload(job.id)).needsApproval).toBe(false);
            });
        });

        it('is harmless when redelivered', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            await service.handle('workflow_run', runPayload());
            expect(await service.handle('workflow_run', runPayload()))
                .toBe('ignored: job awaiting_review cannot take ci_passed');
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });
    });

    describe('pull_request_review', () => {
        const review = (assoc: string, over: Record<string, unknown> = {}) => ({
            action: 'submitted',
            repository: { full_name: 'gilde-dev/gilde' },
            pull_request: prPayload('x').pull_request,
            review: { state: 'changes_requested', body: 'Please rename it.', author_association: assoc, user: { login: 'alice' }, ...over },
        });

        it('requeues the job with the review body when an owner requests changes', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, branch: 'b', headSha: SHA1 });
            const res = await service.handle('pull_request_review', review('OWNER'));
            expect(res).toBe('job queued with PR #12');
            expect(await reload(job.id)).toMatchObject({
                status: 'queued', prNumber: 12, branch: 'b',
                lastReason: 'Changes requested by @alice on PR #12:\nPlease rename it.',
            });
        });

        it('ignores outside contributors and other review states', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            expect(await service.handle('pull_request_review', review('CONTRIBUTOR'))).toContain('ignored');
            expect(await service.handle('pull_request_review', review('OWNER', { state: 'approved' }))).toContain('ignored');
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });
    });

    describe('feedback', () => {
        const repository = { full_name: 'gilde-dev/gilde' };
        const pull_request = () => prPayload('x').pull_request;
        const reviewEvent = (over: Record<string, unknown> = {}) => ({
            action: 'submitted', repository, pull_request: pull_request(),
            review: {
                id: 9001, state: 'COMMENTED', body: 'Looks mostly fine.', author_association: 'OWNER',
                user: { login: 'alice' }, html_url: 'https://github.com/gilde-dev/gilde/pull/12#pullrequestreview-9001',
                submitted_at: '2026-10-01T10:00:00Z', ...over,
            },
        });
        const inlineEvent = (id: number, reviewId: number | null, over: Record<string, unknown> = {}) => ({
            action: 'created', repository, pull_request: pull_request(),
            comment: {
                id, pull_request_review_id: reviewId, path: 'src/a.ts', line: 7, body: `fix ${id}`,
                author_association: 'OWNER', user: { login: 'alice' },
                html_url: `https://github.com/gilde-dev/gilde/pull/12#discussion_r${id}`,
                created_at: '2026-10-01T09:59:00Z', ...over,
            },
        });
        const issueEvent = (over: Record<string, unknown> = {}, issue: Record<string, unknown> = { number: 12, pull_request: { url: 'x' } }) => ({
            action: 'created', repository, issue,
            comment: {
                id: 555, body: 'Ship it?', author_association: 'MEMBER', user: { login: 'bob' },
                html_url: 'https://github.com/gilde-dev/gilde/pull/12#issuecomment-555', created_at: '2026-10-01T11:00:00Z', ...over,
            },
        });

        it('stores a review, lowercasing its state', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            await service.handle('pull_request_review', reviewEvent({ state: 'APPROVED' }));
            expect(await feedbackService.listForJob(job.id)).toMatchObject([{
                jobId: job.id, projectId: job.projectId, repoId: job.repoId, prNumber: 12, kind: 'review', githubId: '9001',
                author: 'alice', authorAssociation: 'OWNER', state: 'approved', reviewId: null, path: null, line: null,
                body: 'Looks mostly fine.', url: 'https://github.com/gilde-dev/gilde/pull/12#pullrequestreview-9001',
                createdAt: '2026-10-01T10:00:00.000Z',
            }]);
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });

        it('stores an inline review comment without touching the job', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            expect(await service.handle('pull_request_review_comment', inlineEvent(77, 9001))).toBe('stored review comment for PR #12');
            expect(await feedbackService.listForJob(job.id)).toMatchObject([
                { kind: 'review_comment', githubId: '77', reviewId: '9001', path: 'src/a.ts', line: 7, body: 'fix 77', state: null },
            ]);
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });

        it('stores a comment on a pull request but ignores comments on plain issues', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            expect(await service.handle('issue_comment', issueEvent({}, { number: 12 }))).toContain('ignored');
            expect(await service.handle('issue_comment', issueEvent())).toBe('stored comment for PR #12');
            expect(await feedbackService.listForJob(job.id)).toMatchObject([
                { kind: 'comment', githubId: '555', author: 'bob', authorAssociation: 'MEMBER', body: 'Ship it?' },
            ]);
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });

        it('ignores feedback on unknown PRs', async () => {
            await seedJob('awaiting_review', { prNumber: 99, headSha: SHA1 });
            expect(await service.handle('pull_request_review', reviewEvent())).toContain('not a known job PR');
            expect(await service.handle('pull_request_review_comment', inlineEvent(1, null))).toContain('not a known job PR');
            expect(await service.handle('issue_comment', issueEvent())).toContain('not a known job PR');
            expect(await ds.getRepository(Feedback).count()).toBe(0);
        });

        it('does not duplicate redelivered events', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            for (let i = 0; i < 2; i++) {
                await service.handle('pull_request_review', reviewEvent());
                await service.handle('pull_request_review_comment', inlineEvent(77, 9001));
                await service.handle('issue_comment', issueEvent());
            }
            expect(await feedbackService.listForJob(job.id)).toHaveLength(3);
        });

        it('adds the stored inline comments of that review to the changes_requested retry reason', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, branch: 'b', headSha: SHA1 });
            await service.handle('pull_request_review_comment', inlineEvent(1, 9001, { path: 'src/a.ts', line: 7, body: 'rename' }));
            await service.handle('pull_request_review_comment', inlineEvent(2, 9001, { path: 'src/b.ts', line: 3, body: 'add test', created_at: '2026-10-01T09:59:30Z' }));
            await service.handle('pull_request_review_comment', inlineEvent(3, 4242, { body: 'other review' }));
            const res = await service.handle('pull_request_review', reviewEvent({ state: 'changes_requested', body: 'Please fix.' }));
            expect(res).toBe('job queued with PR #12');
            expect((await reload(job.id)).lastReason).toBe(
                'Changes requested by @alice on PR #12:\nPlease fix.\n- src/a.ts:7 rename\n- src/b.ts:3 add test',
            );
        });
    });

    describe('/gilde retry comment', () => {
        const comment = (body: string, assoc = 'OWNER', id = 600) => ({
            action: 'created', repository: { full_name: 'gilde-dev/gilde' }, issue: { number: 12, pull_request: { url: 'x' } },
            comment: { id, body, author_association: assoc, user: { login: 'bob' }, html_url: 'u', created_at: '2026-10-01T11:00:00Z' },
        });

        it('requeues the job with the comment text and unaddressed inline comments', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, branch: 'claude/x', headSha: SHA1 });
            await service.handle('pull_request_review_comment', {
                action: 'created', repository: { full_name: 'gilde-dev/gilde' }, pull_request: prPayload('x').pull_request,
                comment: { id: 77, path: 'a.ts', line: 3, body: 'fix me', author_association: 'OWNER', user: { login: 'bob' }, created_at: '2026-10-01T09:00:00Z' },
            });
            const res = await service.handle('issue_comment', comment('/GILDE retry  please tidy up'));
            expect(res).toContain('job queued');
            const after = await reload(job.id);
            expect(after.status).toBe('queued');
            expect(after.prNumber).toBe(12);
            expect(after.lastReason).toBe('Sent back by the reviewer: please tidy up\n- a.ts:3 fix me');
        });

        it('uses a default reason when there is no text', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            await service.handle('issue_comment', comment('/gilde retry'));
            expect((await reload(job.id)).lastReason).toBe('Sent back by the reviewer: Address the review comments on the PR.');
        });

        it('only stores comments from others and from non-commands', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            expect(await service.handle('issue_comment', comment('/gilde retry', 'CONTRIBUTOR'))).toContain('ignored');
            expect(await service.handle('issue_comment', comment('please /gilde retry', 'OWNER', 601))).toBe('stored comment for PR #12');
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });

        it('does not requeue twice on a redelivery', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            await service.handle('issue_comment', comment('/gilde retry'));
            await jobs.update({ id: job.id }, { status: 'pr_open' });
            expect(await service.handle('issue_comment', comment('/gilde retry'))).toContain('unchanged');
            expect((await reload(job.id)).status).toBe('pr_open');
        });
    });

    describe('after a retry', () => {
        it('moves a re-dispatched job to pr_open on push, and ignores a second PR', async () => {
            const job = await seedJob('dispatched', { prNumber: 12, branch: 'b', headSha: SHA1, attempts: 2 });
            const res = await service.handle('pull_request', prPayload('synchronize', { head: { ref: 'b', sha: SHA2 } }));
            expect(res).toBe('job pr_open with PR #12');
            expect(await reload(job.id)).toMatchObject({ status: 'pr_open', headSha: SHA2 });

            const second = prPayload('opened', { number: 13, body: body(job, null) });
            second.pull_request.number = 13;
            expect(await service.handle('pull_request', second)).toBe('ignored: job already has PR #12');
        });
    });

    describe('closed', () => {
        it('moves a merged PR to merged, freeing the concurrency slot', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            const res = await service.handle('pull_request', prPayload('closed', { merged: true }));
            expect(res).toBe('job merged with PR #12');
            expect((await reload(job.id)).status).toBe('merged');
        });

        it('sets finished_at on the last run when the PR is merged', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            const run = await seedRun(job);
            await service.handle('pull_request', prPayload('closed', { merged: true }));
            expect((await reloadRun(run.id)).finishedAt).toBeInstanceOf(Date);
        });

        it('sets finished_at on the last run when the PR is closed unmerged', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            const run = await seedRun(job);
            await service.handle('pull_request', prPayload('closed'));
            expect((await reloadRun(run.id)).finishedAt).toBeInstanceOf(Date);
        });

        it('moves an unmerged close to rejected', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            await service.handle('pull_request', prPayload('closed'));
            expect((await reload(job.id)).status).toBe('rejected');
        });

        it('ends a job mid-retry as merged and supersedes the active run', async () => {
            const job = await seedJob('dispatched', { prNumber: 12, headSha: SHA1, attempts: 2 });
            const old = await seedRun(job, 1);
            await runs.update({ id: old.id }, { status: 'ci_failed' });
            const active = await seedRun(job, 2);
            const res = await service.handle('pull_request', prPayload('closed', { merged: true }));
            expect(res).toBe('job merged with PR #12');
            expect((await reload(job.id)).status).toBe('merged');
            expect((await reloadRun(active.id)).status).toBe('superseded');
            expect((await reloadRun(old.id)).status).toBe('ci_failed');
        });

        it('is harmless when redelivered', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            await service.handle('pull_request', prPayload('closed', { merged: true }));
            expect(await service.handle('pull_request', prPayload('closed', { merged: true })))
                .toBe('ignored: job merged cannot take merged');
            expect((await reload(job.id)).status).toBe('merged');
        });
    });
});

describe('notification events', () => {
    const kinds = async () => (await notifications.find({ order: { createdAt: 'ASC' } })).map((n) => n.kind);
    const REASON = 'Protected paths changed; add the gilde:allow-protected label if intended';

    it('records job.awaiting_review once per job, attempt and head, even when CI is redelivered', async () => {
        const job = await seedJob('pr_open', { prNumber: 12, prUrl: 'https://github.com/gilde-dev/gilde/pull/12', headSha: SHA1 });
        await service.handle('workflow_run', runPayload());
        await service.handle('workflow_run', runPayload());
        const rows = await notifications.find();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: 'job.awaiting_review', jobId: job.id, projectId: job.projectId, title: 'T', repos: ['gilde-dev/gilde'],
            prLinks: [{ repo: 'gilde-dev/gilde', number: 12, url: 'https://github.com/gilde-dev/gilde/pull/12' }],
            occurrenceKey: `job.awaiting_review:${job.id}:a1:${SHA1}`,
        });
    });

    it('records a new awaiting_review event for a new head', async () => {
        const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
        await service.handle('workflow_run', runPayload());
        await jobs.update({ id: job.id }, { status: 'pr_open', headSha: SHA2 });
        await service.handle('workflow_run', runPayload({ head_sha: SHA2 }));
        expect(await kinds()).toEqual(['job.awaiting_review', 'job.awaiting_review']);
    });

    it('records nothing for stale CI, a passing CI that loses the write, or a job that cannot take it', async () => {
        await seedJob('pr_open', { prNumber: 12, headSha: SHA2 });
        await service.handle('workflow_run', runPayload());
        expect(await notifications.count()).toBe(0);

        const job = await seedJob('pr_open', { prNumber: 13, headSha: SHA1 });
        const stale = await reload(job.id);
        await jobs.update({ id: job.id }, { status: 'merged' });
        const events = (service as unknown as { events: JobEventsService }).events;
        await events.workflowCompleted(stale, 13, { name: 'CI', conclusion: 'success', headSha: SHA1 });
        expect(await notifications.count()).toBe(0);
    });

    it('records job.parked when CI failure exhausts attempts, with the cause in the key, and not when requeued', async () => {
        await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
        await service.handle('workflow_run', runPayload({ conclusion: 'failure' }));
        expect(await notifications.count()).toBe(0);

        const job = await seedJob('pr_open', { prNumber: 14, headSha: SHA2, attempts: 3 });
        await service.handle('workflow_run', runPayload({ conclusion: 'failure', head_sha: SHA2, pull_requests: [{ number: 14 }] }));
        const rows = await notifications.find();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'job.parked', jobId: job.id, occurrenceKey: `job.parked:${job.id}:a3:${SHA2}:failure` });
        expect(rows[0].reason).toContain('CI failure');
    });

    it('records one approval request per job, attempt and head and none for stale or passing gates', async () => {
        const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
        const gate = runPayload({ name: 'Gates', conclusion: 'failure' });
        await service.handle('workflow_run', gate);
        await service.handle('workflow_run', runPayload({ name: 'Gates', conclusion: 'success' }));
        await service.handle('workflow_run', gate); // cleared and set again: same logical request
        const rows = await notifications.find();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'job.approval_needed', jobId: job.id, reason: REASON });

        await jobs.update({ id: job.id }, { headSha: SHA2 });
        await service.handle('workflow_run', gate); // stale
        expect(await notifications.count()).toBe(1);
        await service.handle('workflow_run', runPayload({ name: 'Gates', conclusion: 'failure', head_sha: SHA2 }));
        expect(await notifications.count()).toBe(2);
    });

    it('does not record an approval request for a finished job', async () => {
        await seedJob('merged', { prNumber: 12, headSha: SHA1 });
        await service.handle('workflow_run', runPayload({ name: 'Gates', conclusion: 'failure' }));
        expect(await notifications.count()).toBe(0);
    });

    it('keeps the original outcome when the notification insert or its enrichment read fails', async () => {
        const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        vi.spyOn(notifications, 'insert').mockRejectedValue(new Error('insert down'));
        const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
        expect(await service.handle('workflow_run', runPayload())).toBe('job awaiting_review with PR #12');
        expect((await reload(job.id)).status).toBe('awaiting_review');

        vi.restoreAllMocks();
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const lookup = repos.findOneBy.bind(repos);
        let calls = 0; // the first lookup is the webhook's own repo resolution; the capture's enrichment read is the next
        vi.spyOn(repos, 'findOneBy').mockImplementation((...args) => (calls++ === 0 ? lookup(...args) : Promise.reject(new Error('read down'))));
        const gated = await seedJob('pr_open', { prNumber: 15, headSha: SHA2 });
        const res = await service.handle('workflow_run', runPayload({ name: 'Gates', conclusion: 'failure', head_sha: SHA2, pull_requests: [{ number: 15 }] }));
        expect(res).toBe('gate failed: job pr_open needs approval for PR #15');
        expect(await reload(gated.id)).toMatchObject({ needsApproval: true });
        expect(await notifications.count()).toBe(0);
        log.mockRestore();
        vi.restoreAllMocks();
    });

    it('sending a job back at max attempts records a parked event of its own cause', async () => {
        const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1, attempts: 3 });
        const events = (service as unknown as { events: JobEventsService }).events;
        expect(await events.sendBack(job, 'nope')).toBe('parked');
        const rows = await notifications.find();
        expect(rows.map((n) => n.occurrenceKey)).toEqual([`job.parked:${job.id}:a3:${SHA1}:sent_back`]);
    });
});
