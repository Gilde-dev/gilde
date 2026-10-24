import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubRestAdapter } from '../github/github-rest.adapter.js';
import type { GitHubPort, GitHubPull, GitHubWorkflowRun } from '../github/github.port.js';
import { JobEventsService } from '../job/job-events.service.js';
import type { JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { ReconcilerService } from './reconciler.service.js';

const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'ffeeddccbbaa99887766554433221100ffeeddcc';

let ds: DataSource;
let jobs: Repository<Job>;
let projects: Repository<Project>;
let repo: Repo;
let github: GitHubPort & { pulls: Map<number, GitHubPull>; recent: GitHubPull[]; workflows: GitHubWorkflowRun[] };
let service: ReconcilerService;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [Project, Repo, Job, JobRun], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    projects = ds.getRepository(Project);
    const project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
    repo = await ds.getRepository(Repo).save(
        ds.getRepository(Repo).create({ projectId: project.id, fullName: 'gilde-dev/gilde', testCommand: 'pnpm test' }),
    );
    github = {
        pulls: new Map(), recent: [], workflows: [],
        isConfigured: () => true,
        getPull: async (_f, n) => github.pulls.get(n)!,
        listRecentPulls: async () => github.recent,
        listWorkflowRuns: async () => github.workflows,
    };
    const events = new JobEventsService(jobs, ds.getRepository(JobRun), projects);
    service = new ReconcilerService(github, events, jobs, ds.getRepository(Repo));
});

afterEach(() => ds.destroy());

async function seedJob(status: JobStatus, over: Partial<Job> = {}) {
    return jobs.save(jobs.create({
        projectId: repo.projectId, repoId: repo.id, title: 'T', task: 'do', status, queuedAt: new Date(), attempts: 1, ...over,
    }));
}
const reload = (id: string) => jobs.findOneByOrFail({ id });

function pull(over: Partial<GitHubPull> = {}): GitHubPull {
    return {
        number: 12, state: 'open', merged: false, headSha: SHA1, headRef: 'claude/gilde-x',
        htmlUrl: 'https://github.com/gilde-dev/gilde/pull/12', body: null, ...over,
    };
}
const prJob = (status: JobStatus, over: Partial<Job> = {}) =>
    seedJob(status, { prNumber: 12, prUrl: 'u', branch: 'b', headSha: SHA1, ...over });
const completed = (name: string, conclusion: string): GitHubWorkflowRun => ({ name, status: 'completed', conclusion });

describe('ReconcilerService', () => {
    it('links a missed opened PR by its marker', async () => {
        const job = await seedJob('dispatched');
        github.recent = [pull({ number: 3, body: 'other' }), pull({ body: `Did it.\n\ngilde-job: ${job.id}\n` })];

        expect(await service.reconcile()).toEqual({ checked: 1, corrected: 1 });
        const after = await reload(job.id);
        expect(after).toMatchObject({ status: 'pr_open', prNumber: 12, headSha: SHA1, branch: 'claude/gilde-x' });
    });

    it('applies a missed merge', async () => {
        const job = await prJob('awaiting_review');
        github.pulls.set(12, pull({ state: 'closed', merged: true }));
        expect(await service.reconcile()).toEqual({ checked: 1, corrected: 1 });
        expect((await reload(job.id)).status).toBe('merged');
    });

    it('applies a missed close', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull({ state: 'closed' }));
        await service.reconcile();
        expect((await reload(job.id)).status).toBe('rejected');
    });

    it('applies a merge for a queued retry', async () => {
        const job = await prJob('queued');
        github.pulls.set(12, pull({ state: 'closed', merged: true }));
        await service.reconcile();
        expect((await reload(job.id)).status).toBe('merged');
    });

    it('ignores queued jobs without a PR', async () => {
        await seedJob('queued');
        expect(await service.reconcile()).toEqual({ checked: 0, corrected: 0 });
    });

    it('applies missed new commits', async () => {
        const job = await prJob('awaiting_review');
        github.pulls.set(12, pull({ headSha: SHA2 }));
        await service.reconcile();
        expect(await reload(job.id)).toMatchObject({ status: 'pr_open', headSha: SHA2 });
    });

    it('applies a missed CI success', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull());
        github.workflows = [completed('CI', 'success')];
        await service.reconcile();
        expect((await reload(job.id)).status).toBe('awaiting_review');
    });

    it('ignores in-progress runs', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull());
        github.workflows = [{ name: 'CI', status: 'in_progress', conclusion: null }];
        expect(await service.reconcile()).toEqual({ checked: 1, corrected: 0 });
        expect((await reload(job.id)).status).toBe('pr_open');
    });

    it('retries a job after a missed CI failure', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull());
        github.workflows = [completed('CI', 'failure')];
        await service.reconcile();
        const after = await reload(job.id);
        expect(after.status).toBe('queued');
        expect(after.lastReason).toContain('CI failure');
    });

    it('flags failed gates for approval without retrying', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull());
        github.workflows = [completed('Gates', 'failure')];
        expect(await service.reconcile()).toEqual({ checked: 1, corrected: 1 });
        expect(await reload(job.id)).toMatchObject({ status: 'pr_open', needsApproval: true });
    });

    it('flags a gate failure and still applies CI success', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull());
        github.workflows = [completed('CI', 'success'), completed('Gates', 'failure')];
        await service.reconcile();
        expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review', needsApproval: true });
    });

    it('uses only the newest run per workflow', async () => {
        const job = await prJob('pr_open');
        github.pulls.set(12, pull());
        github.workflows = [completed('CI', 'success'), completed('CI', 'failure')];
        await service.reconcile();
        expect((await reload(job.id)).status).toBe('awaiting_review');
    });

    it('changes nothing on a second run', async () => {
        const opened = await seedJob('dispatched');
        const failing = await prJob('pr_open', { prNumber: 13 });
        const gated = await prJob('pr_open', { prNumber: 14 });
        github.recent = [pull({ body: `gilde-job: ${opened.id}` })];
        github.pulls.set(12, pull());
        github.pulls.set(13, pull({ number: 13 }));
        github.pulls.set(14, pull({ number: 14 }));
        github.workflows = [completed('Gates', 'failure'), completed('CI', 'failure')];

        const first = await service.reconcile();
        expect(first.corrected).toBeGreaterThan(0);
        const states = async () => Promise.all([opened, failing, gated].map(async (j) => {
            const { status, prNumber, headSha, needsApproval, attempts } = await reload(j.id);
            return { status, prNumber, headSha, needsApproval, attempts };
        }));
        const snapshot = await states();

        expect((await service.reconcile()).corrected).toBe(0);
        expect(await states()).toEqual(snapshot);
    });

    it('does nothing and does not throw without a token', async () => {
        vi.stubEnv('GITHUB_TOKEN', '');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const events = new JobEventsService(jobs, ds.getRepository(JobRun), projects);
        const unconfigured = new ReconcilerService(new GitHubRestAdapter(), events, jobs, ds.getRepository(Repo));
        const job = await prJob('pr_open');

        expect(() => unconfigured.onModuleInit()).not.toThrow();
        expect(await unconfigured.reconcile()).toEqual({ checked: 0, corrected: 0 });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect((await reload(job.id)).status).toBe('pr_open');
        fetchSpy.mockRestore();
        vi.unstubAllEnvs();
    });

    it('skips an overlapping pass', async () => {
        await prJob('pr_open');
        let release!: () => void;
        github.getPull = () => new Promise((res) => { release = () => res(pull()); });
        const first = service.reconcile();
        await vi.waitFor(() => expect(release).toBeDefined());
        expect(await service.reconcile()).toEqual({ checked: 0, corrected: 0 });
        release();
        expect((await first).checked).toBe(1);
    });

    it('continues after a GitHub error for one job', async () => {
        const bad = await prJob('pr_open', { prNumber: 99 });
        const good = await prJob('pr_open');
        github.getPull = async (_f, n) => {
            if (n === 99) throw new Error('GitHub GET failed: 500');
            return pull({ state: 'closed', merged: true });
        };
        expect(await service.reconcile()).toEqual({ checked: 2, corrected: 1 });
        expect((await reload(bad.id)).status).toBe('pr_open');
        expect((await reload(good.id)).status).toBe('merged');
    });
});

describe('GitHubRestAdapter', () => {
    it('sends the required headers and maps pulls', async () => {
        vi.stubEnv('GITHUB_TOKEN', 'secret-token');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            number: 5, state: 'closed', merged: true, html_url: 'h', body: 'b', head: { sha: 's', ref: 'r' },
        })));
        const result = await new GitHubRestAdapter().getPull('o/r', 5);
        expect(result).toEqual({ number: 5, state: 'closed', merged: true, headSha: 's', headRef: 'r', htmlUrl: 'h', body: 'b' });
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.github.com/repos/o/r/pulls/5');
        expect(init?.headers).toMatchObject({
            Authorization: 'Bearer secret-token', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        });
        fetchSpy.mockRestore();
        vi.unstubAllEnvs();
    });

    it('never puts the token in errors', async () => {
        vi.stubEnv('GITHUB_TOKEN', 'secret-token');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));
        const err = await new GitHubRestAdapter().listRecentPulls('o/r').catch((e: Error) => e);
        expect((err as Error).message).toContain('401');
        expect((err as Error).message).not.toContain('secret-token');
        fetchSpy.mockRestore();
        vi.unstubAllEnvs();
    });
});
