import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitHubPort } from '../github/github.port.js';
import { JobEventsService } from '../job/job-events.service.js';
import { Job } from '../job/job.entity.js';
import { MergeConflictService } from '../job/merge-conflict.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import type { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import { WebhookService } from './webhook.service.js';

let ds: DataSource;
let service: WebhookService;
let getPull: ReturnType<typeof vi.fn>;
let job: Job;
let repo: Repo;

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun], synchronize: true }).initialize();
    const project = await ds.getRepository(Project).save({ slug: 'p', name: 'P' });
    repo = await ds.getRepository(Repo).save({ projectId: project.id, fullName: 'o/r', defaultBranch: 'main', testCommands: ['t'] });
    job = await ds.getRepository(Job).save(ds.getRepository(Job).create({
        projectId: project.id, repoId: repo.id, title: 'T', task: 't', status: 'awaiting_review', attempts: 1, prNumber: 12, branch: 'b', headSha: 'old',
    }));
    getPull = vi.fn().mockResolvedValue({ number: 12, state: 'open', merged: false, headSha: 'new', headRef: 'b', htmlUrl: 'u', body: null, mergeableState: 'dirty' });
    const github = { isConfigured: () => true, getPull } as unknown as GitHubPort;
    const events = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project));
    const conflicts = new MergeConflictService(github, events, ds.getRepository(Job), ds.getRepository(Project), ds.getRepository(Repo));
    const repoService = { findByFullName: (n: string) => ds.getRepository(Repo).findOneBy({ fullName: n }) } as unknown as RepoService;
    service = new WebhookService(repoService, {} as never, ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), events, undefined, undefined, undefined, undefined, conflicts);
});
afterEach(() => ds.destroy());

const push = (ref: string) => ({ ref, repository: { full_name: 'o/r', default_branch: 'main' } });
const sync = () => ({
    action: 'synchronize', repository: { full_name: 'o/r' },
    pull_request: { number: 12, html_url: 'u', body: null, head: { ref: 'b', sha: 'new' } },
});
const reload = () => ds.getRepository(Job).findOneByOrFail({ id: job.id });

describe('merge conflict checks from webhooks', () => {
    it('re-checks the open agent PRs after a push to the default branch', async () => {
        expect(await service.handle('push', push('refs/heads/main'))).toContain('checked merge state of 1 open agent PRs');
        expect(await reload()).toMatchObject({ mergeConflict: true });
    });

    it('ignores pushes to other branches', async () => {
        expect(await service.handle('push', push('refs/heads/feature'))).toContain('ignored');
        expect(getPull).not.toHaveBeenCalled();
    });

    it('re-checks the PR after a synchronize event', async () => {
        await service.handle('pull_request', sync());
        expect(await reload()).toMatchObject({ headSha: 'new', mergeConflict: true });
    });

    it('treats an unknown state as unknown and keeps the flag', async () => {
        await ds.getRepository(Job).update({ id: job.id }, { mergeConflict: true });
        getPull.mockResolvedValue({ number: 12, state: 'open', merged: false, headSha: 'new', headRef: 'b', htmlUrl: 'u', body: null, mergeableState: 'unknown' });
        await service.handle('push', push('refs/heads/main'));
        expect(await reload()).toMatchObject({ mergeConflict: true, mergeConflictCheckedAt: null });
    });

    it('does not fail the event when GitHub cannot be read', async () => {
        getPull.mockRejectedValue(new Error('down'));
        await expect(service.handle('pull_request', sync())).resolves.toContain('PR #12');
        expect(await reload()).toMatchObject({ mergeConflict: false });
    });

    it('clears the flag when the PR is merged', async () => {
        await ds.getRepository(Job).update({ id: job.id }, { mergeConflict: true });
        await service.handle('pull_request', { action: 'closed', repository: { full_name: 'o/r' }, pull_request: { number: 12, html_url: 'u', body: null, merged: true, head: { ref: 'b', sha: 'new' } } });
        expect(await reload()).toMatchObject({ status: 'merged', mergeConflict: false });
    });
});
