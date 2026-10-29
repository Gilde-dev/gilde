import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitHubPort, GitHubPull } from '../github/github.port.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import { JobEventsService } from './job-events.service.js';
import { Job } from './job.entity.js';
import type { JobStatus } from './job-state.js';
import { MergeConflictService, conflictFixReason, mergeConflictFrom } from './merge-conflict.service.js';

let ds: DataSource;
let service: MergeConflictService;
let events: JobEventsService;
let getPull: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun], synchronize: true,
    }).initialize();
    events = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project));
    getPull = vi.fn();
    const github = { isConfigured: () => true, getPull } as unknown as GitHubPort;
    service = new MergeConflictService(github, events, ds.getRepository(Job), ds.getRepository(Project), ds.getRepository(Repo));
});
afterEach(() => ds.destroy());

let n = 0;
async function seed(status: JobStatus = 'awaiting_review', over: Partial<Job> = {}, project: Partial<Project> = {}) {
    const p = await ds.getRepository(Project).save({ slug: `p${++n}`, name: 'P', maxAttempts: 2, ...project });
    const r = await ds.getRepository(Repo).save({ projectId: p.id, fullName: `a/b${n}`, defaultBranch: 'develop', testCommands: ['t'] });
    return ds.getRepository(Job).save(ds.getRepository(Job).create({
        projectId: p.id, repoId: r.id, title: 'T', task: 't', status, attempts: 1, prNumber: 5, branch: 'b', headSha: 'h1', ...over,
    }));
}
const pull = (over: Partial<GitHubPull> = {}): GitHubPull => ({
    number: 5, state: 'open', merged: false, headSha: 'h1', headRef: 'b', htmlUrl: 'u', body: null, mergeableState: 'dirty', ...over,
});
const reload = (id: string) => ds.getRepository(Job).findOneByOrFail({ id });

describe('mergeConflictFrom', () => {
    it.each([['dirty', true], ['clean', false], ['has_hooks', false], ['unstable', false], ['unknown', null], [null, null], [undefined, null], ['something_new', null]] as const)(
        '%s → %s', (state, expected) => expect(mergeConflictFrom(state)).toBe(expected));
});

describe('applyPull', () => {
    it('sets the flag and the check time on dirty, and clears it when the PR becomes mergeable', async () => {
        const job = await seed();
        await service.applyPull(job, pull());
        expect(await reload(job.id)).toMatchObject({ mergeConflict: true });
        expect((await reload(job.id)).mergeConflictCheckedAt).toBeInstanceOf(Date);
        await service.applyPull(await reload(job.id), pull({ mergeableState: 'clean' }));
        expect(await reload(job.id)).toMatchObject({ mergeConflict: false });
    });

    it('leaves the flag and the check time alone while GitHub does not know', async () => {
        const job = await seed('awaiting_review', { mergeConflict: true });
        for (const mergeableState of ['unknown', null, undefined]) await service.applyPull(job, pull({ mergeableState }));
        expect(await reload(job.id)).toMatchObject({ mergeConflict: true, mergeConflictCheckedAt: null });
    });

    it('ignores closed PRs and PRs of other jobs', async () => {
        const job = await seed();
        await service.applyPull(job, pull({ state: 'closed' }));
        await service.applyPull(job, pull({ number: 6 }));
        expect(await reload(job.id)).toMatchObject({ mergeConflict: false });
    });

    it('clears the flag when the PR is merged or closed', async () => {
        const job = await seed('awaiting_review', { mergeConflict: true });
        await events.prClosed(job, 5, true);
        expect(await reload(job.id)).toMatchObject({ status: 'merged', mergeConflict: false });
    });
});

describe('checkJob / checkRepo / checkPr', () => {
    it('reads the PR and applies it; a failed read changes nothing', async () => {
        const job = await seed();
        getPull.mockRejectedValueOnce(new Error('boom'));
        await service.checkJob(job);
        expect(await reload(job.id)).toMatchObject({ mergeConflict: false });
        getPull.mockResolvedValue(pull());
        await service.checkJob(job);
        expect(getPull).toHaveBeenLastCalledWith(expect.stringMatching(/^a\/b/), 5);
        expect(await reload(job.id)).toMatchObject({ mergeConflict: true });
    });

    it('checkRepo covers the open agent PRs of the repo only', async () => {
        const a = await seed('pr_open');
        await ds.getRepository(Job).save(ds.getRepository(Job).create({ projectId: a.projectId, repoId: a.repoId, title: 'M', task: 't', status: 'merged', prNumber: 9 }));
        getPull.mockResolvedValue(pull());
        expect(await service.checkRepo(a.repoId)).toBe(1);
        expect(getPull).toHaveBeenCalledTimes(1);
        await service.checkPr(a.repoId, 5);
        expect(getPull).toHaveBeenCalledTimes(2);
    });
});

describe('fixConflicts', () => {
    it.each(['pr_open', 'awaiting_review'] as const)('requeues a conflicted %s job with the fixed reason and no attempt used', async (status) => {
        const job = await seed(status, { mergeConflict: true, attempts: 2 });
        expect(await service.fixConflicts(job.id)).toBe('queued');
        const after = await reload(job.id);
        expect(after).toMatchObject({ status: 'queued', attempts: 2, prNumber: 5, branch: 'b', nextRoundKind: 'conflict_fix', lastReason: conflictFixReason('develop') });
        expect(after.lastReason).toContain('git fetch origin && git merge origin/develop');
        expect(after.lastReason).toContain('do not rebase or force-push');
        expect(after.lastReason).toContain('report blocked and list the conflicting files');
    });

    it('does not park at max attempts', async () => {
        const job = await seed('awaiting_review', { mergeConflict: true, attempts: 2 });
        expect(await service.fixConflicts(job.id)).toBe('queued');
    });

    it('a normal send-back still counts and parks at max attempts, and clears the round kind', async () => {
        const job = await seed('awaiting_review', { mergeConflict: true, attempts: 2 });
        expect(await events.sendBack(job, 'x')).toBe('parked');
        const queued = await seed('awaiting_review', { nextRoundKind: 'conflict_fix', attempts: 1 });
        await events.sendBack(queued, 'x');
        expect(await reload(queued.id)).toMatchObject({ status: 'queued', nextRoundKind: null });
    });

    it('404 for an unknown job; 409 without a conflict, without a PR or in another status', async () => {
        await expect(service.fixConflicts('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
        for (const job of [
            await seed('awaiting_review', { mergeConflict: false }),
            await seed('awaiting_review', { mergeConflict: true, prNumber: null }),
            await seed('queued', { mergeConflict: true }),
            await seed('dispatched', { mergeConflict: true }),
            await seed('merged', { mergeConflict: true }),
        ]) {
            await expect(service.fixConflicts(job.id)).rejects.toBeInstanceOf(ConflictException);
        }
    });
});

describe('automatic fixing', () => {
    it('starts one round per head when autoFixConflicts is on', async () => {
        const job = await seed('awaiting_review', {}, { autoFixConflicts: true });
        await service.applyPull(job, pull());
        expect(await reload(job.id)).toMatchObject({ status: 'queued', nextRoundKind: 'conflict_fix', autoFixHeadSha: 'h1', attempts: 1 });

        // The agent pushed a head that still conflicts and the same head is seen again: no second round for h1 ...
        await ds.getRepository(Job).update({ id: job.id }, { status: 'pr_open' });
        await service.applyPull(await reload(job.id), pull());
        expect(await reload(job.id)).toMatchObject({ status: 'pr_open' });

        // ... but a new head may get one.
        await service.applyPull(await reload(job.id), pull({ headSha: 'h2' }));
        expect(await reload(job.id)).toMatchObject({ status: 'queued', autoFixHeadSha: 'h2' });
    });

    it('does nothing when the setting is off, and never while the job is dispatched or queued', async () => {
        const off = await seed('awaiting_review');
        await service.applyPull(off, pull());
        expect(await reload(off.id)).toMatchObject({ status: 'awaiting_review', mergeConflict: true, autoFixHeadSha: null });

        for (const status of ['dispatched', 'queued'] as const) {
            const job = await seed(status, {}, { autoFixConflicts: true, });
            await service.applyPull(job, pull());
            expect(await reload(job.id)).toMatchObject({ status, nextRoundKind: null, autoFixHeadSha: null });
        }
    });

    it('does not start a round for an unknown state', async () => {
        const job = await seed('awaiting_review', {}, { autoFixConflicts: true });
        await service.applyPull(job, pull({ mergeableState: 'unknown' }));
        expect(await reload(job.id)).toMatchObject({ status: 'awaiting_review' });
    });

    it('concurrent observations of one head start a single round', async () => {
        const job = await seed('awaiting_review', {}, { autoFixConflicts: true });
        await Promise.all([service.applyPull(job, pull()), service.applyPull(job, pull())]);
        expect(await reload(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    });
});
