import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import type { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { WebhookService } from './webhook.service.js';

const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'ffeeddccbbaa99887766554433221100ffeeddcc';

let ds: DataSource;
let projects: Repository<Project>;
let repos: Repository<Repo>;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let service: WebhookService;
let repo: Repo;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [Project, Repo, Job, JobRun], synchronize: true,
    }).initialize();
    projects = ds.getRepository(Project);
    repos = ds.getRepository(Repo);
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    const project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
    repo = await repos.save(repos.create({ projectId: project.id, fullName: 'gilde-dev/gilde', testCommand: 'pnpm test' }));
    const repoService = {
        findByFullName: (n: string) => repos.findOneBy({ fullName: n.toLowerCase() }),
    } as unknown as RepoService;
    service = new WebhookService(repoService, jobs, runs);
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

function suitePayload(over: Record<string, unknown> = {}) {
    return {
        action: 'completed',
        repository: { full_name: 'gilde-dev/gilde' },
        check_suite: {
            id: 1, status: 'completed', conclusion: 'success', head_sha: SHA1,
            app: { slug: 'github-actions' }, pull_requests: [{ number: 12 }], ...over,
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
            const other = await repos.save(repos.create({ projectId: repo.projectId, fullName: 'o/other', testCommand: 'x' }));
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
            await service.handle('check_suite', suitePayload());
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
    });

    describe('check_suite', () => {
        it.each(['success', 'neutral', 'skipped'])('moves the job to awaiting_review on %s', async (conclusion) => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            const run = await seedRun(job);
            const res = await service.handle('check_suite', suitePayload({ conclusion }));
            expect(res).toBe('job awaiting_review with PR #12');
            expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review' });
            expect(await reloadRun(run.id)).toMatchObject({ status: 'ci_passed', ciConclusion: conclusion });
        });

        it('parks the job on failure with the reason', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            const run = await seedRun(job);
            await service.handle('check_suite', suitePayload({ conclusion: 'failure' }));
            expect(await reload(job.id)).toMatchObject({ status: 'parked', lastReason: 'CI failure on a1b2c3d' });
            expect(await reloadRun(run.id)).toMatchObject({ status: 'ci_failed', ciConclusion: 'failure' });
        });

        it('ignores a stale check suite', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA2 });
            const res = await service.handle('check_suite', suitePayload({ conclusion: 'failure' }));
            expect(res).toBe('ignored: stale check_suite a1b2c3d for PR #12');
            expect((await reload(job.id)).status).toBe('pr_open');
        });

        it('ignores other apps, unfinished suites and unknown PRs', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            expect(await service.handle('check_suite', suitePayload({ app: { slug: 'circleci' } }))).toContain('ignored');
            expect(await service.handle('check_suite', { ...suitePayload(), action: 'requested' })).toContain('ignored');
            expect(await service.handle('check_suite', suitePayload({ pull_requests: [{ number: 99 }] }))).toContain('ignored');
            expect((await reload(job.id)).status).toBe('pr_open');
        });

        it('is harmless when redelivered', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            await service.handle('check_suite', suitePayload());
            expect(await service.handle('check_suite', suitePayload()))
                .toBe('ignored: job awaiting_review cannot take ci_passed');
            expect((await reload(job.id)).status).toBe('awaiting_review');
        });
    });

    describe('closed', () => {
        it('moves a merged PR to merged, freeing the concurrency slot', async () => {
            const job = await seedJob('awaiting_review', { prNumber: 12, headSha: SHA1 });
            const res = await service.handle('pull_request', prPayload('closed', { merged: true }));
            expect(res).toBe('job merged with PR #12');
            expect((await reload(job.id)).status).toBe('merged');
        });

        it('moves an unmerged close to rejected', async () => {
            const job = await seedJob('pr_open', { prNumber: 12, headSha: SHA1 });
            await service.handle('pull_request', prPayload('closed'));
            expect((await reload(job.id)).status).toBe('rejected');
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
