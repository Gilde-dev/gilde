import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { J1, P1, memoryDb } from '../lesson/lesson.fixture.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import type { ScoutEvent } from '../scout-signal/scout-signal.events.js';
import { parsePrBody } from '../webhook/pr-body.js';
import { JobEventsService } from './job-events.service.js';
import { Job } from './job.entity.js';

const REPO = '33333333-3333-4333-8333-333333333333';
const REASON = 'Blocked: nothing to do. Close the PR, fix the cause, then retry.';
const body = (runId: string, outcome: string, summary = 'nothing to do') =>
    `gilde-job: ${J1}\ngilde-run: ${runId}\n\n\`\`\`gilde-result\n{"outcome":"${outcome}","summary":"${summary}"}\n\`\`\`\n`;
const pr = (b: string, sha = 'sha1') => ({ number: 7, htmlUrl: 'u', body: b, headRef: 'br', headSha: sha });

describe('a blocked result parks the job', () => {
    let ds: DataSource;
    let events: JobEventsService;
    let jobs: Repository<Job>;
    let runs: Repository<JobRun>;
    let parked: ReturnType<typeof vi.fn>;
    let sent: ScoutEvent[];

    const addRun = (attempt: number, over: Partial<JobRun> = {}) =>
        runs.save({ jobId: J1, projectId: P1, repoId: REPO, attempt, status: 'fired', ...over });
    const job = () => jobs.findOneByOrFail({ id: J1 });
    /** What the webhook's onEdited does: store the body's result on the run, then the shared hook. */
    const edit = async (runId: string, b: string) => {
        const current = await job();
        const run = (await events.findRun(J1, null))!;
        const parsedBody = parsePrBody(b);
        await runs.update({ id: run.id }, { result: parsedBody.result, resultError: parsedBody.resultError, retro: parsedBody.retro });
        await events.recordProposals(current, run, parsedBody);
        return runId;
    };

    beforeEach(async () => {
        ds = await memoryDb();
        jobs = ds.getRepository(Job);
        runs = ds.getRepository(JobRun);
        parked = vi.fn().mockResolvedValue(true);
        sent = [];
        const scout = new ScoutSignalPublisher();
        scout.register(async (_p, e) => { sent.push(e); });
        await ds.getRepository(Project).save({ id: P1, slug: 's', name: 'n', maxAttempts: 3 } as Partial<Project>);
        await jobs.save({ id: J1, projectId: P1, repoId: REPO, title: 't', task: 't', queuedAt: new Date(), status: 'dispatched', attempts: 1 });
        events = new JobEventsService(jobs, runs, ds.getRepository(Project), undefined, undefined, undefined, { jobParked: parked, featureReadiness: vi.fn(), jobAwaitingReview: vi.fn() } as never, scout);
    });
    afterEach(() => ds.destroy());

    it('parks on initial PR linking, with the exact reason and without using attempts', async () => {
        const run = await addRun(1);
        await events.linkPr(REPO, pr(body(run.id, 'blocked')));
        const j = await job();
        expect(j.status).toBe('parked');
        expect(j.lastReason).toBe(REASON);
        expect(j.attempts).toBe(1);
        expect(parked).toHaveBeenCalledTimes(1);
        expect(parked.mock.calls[0]![2]).toBe('blocked');
        expect(sent.map((e) => e.type)).toEqual(['run_outcome']); // the existing run-blocked signal is kept
    });

    it('parks once for redelivery, edited bodies and concurrent processing', async () => {
        const run = await addRun(1);
        const b = body(run.id, 'blocked');
        await events.linkPr(REPO, pr(b));
        await events.linkPr(REPO, pr(b)); // redelivery
        await edit(run.id, b);
        await edit(run.id, b.replace('nothing to do', 'nothing to do')); // edited
        expect(parked).toHaveBeenCalledTimes(1);

        // concurrent: a fresh job in pr_open, two simultaneous edits
        await jobs.update({ id: J1 }, { status: 'pr_open', lastReason: null });
        parked.mockClear();
        await Promise.all([edit(run.id, b), edit(run.id, b)]);
        expect(parked).toHaveBeenCalledTimes(1);
        expect((await job()).status).toBe('parked');
    });

    it('parks a job that is waiting for review when an edit reports blocked', async () => {
        const run = await addRun(1);
        await events.linkPr(REPO, pr(body(run.id, 'done')));
        await jobs.update({ id: J1 }, { status: 'awaiting_review' });
        await edit(run.id, body(run.id, 'blocked'));
        expect((await job()).status).toBe('parked');
    });

    it('does not park when the result write did not land, or for an older attempt', async () => {
        const first = await addRun(1);
        const second = await addRun(2, { status: 'superseded' }); // the conditional update refuses this run
        await events.linkPr(REPO, pr(body(second.id, 'blocked')));
        expect((await job()).status).toBe('pr_open');
        expect(parked).not.toHaveBeenCalled();

        // older-attempt replay: the hook is handed run 1 while attempt 2 is current
        const stale = parsePrBody(body(first.id, 'blocked'));
        await runs.update({ id: first.id }, { result: stale.result });
        await events.recordProposals(await job(), first, stale);
        expect((await job()).status).toBe('pr_open');
        expect(parked).not.toHaveBeenCalled();
    });

    it('does not park for a parsed body whose result is not what is stored', async () => {
        const run = await addRun(1, { result: { outcome: 'done', summary: 'x' } });
        await events.recordProposals(await job(), run, parsePrBody(body(run.id, 'blocked')));
        expect((await job()).status).toBe('dispatched');
    });

    it('keeps the job parked when CI, a review or new commits arrive afterwards', async () => {
        const run = await addRun(1);
        await events.linkPr(REPO, pr(body(run.id, 'blocked')));
        const current = await job();
        await events.workflowCompleted(current, 7, { name: 'CI', conclusion: 'success', headSha: 'sha1' });
        await events.workflowCompleted(current, 7, { name: 'CI', conclusion: 'failure', headSha: 'sha1' });
        await events.retryOrParkJob(current, 'Changes requested');
        await events.prUpdated(current, 7, 'sha2');
        const j = await job();
        expect(j.status).toBe('parked');
        expect(j.lastReason).toBe(REASON);
        expect(parked).toHaveBeenCalledTimes(1);
    });

    it('a later non-blocked run follows the normal path', async () => {
        const first = await addRun(1);
        await events.linkPr(REPO, pr(body(first.id, 'blocked')));
        await jobs.update({ id: J1 }, { status: 'dispatched', attempts: 2, prNumber: null, headSha: null });
        const second = await addRun(2);
        await events.linkPr(REPO, pr(body(second.id, 'done'), 'sha9'));
        expect((await job()).status).toBe('pr_open');
        await events.workflowCompleted(await job(), 7, { name: 'CI', conclusion: 'success', headSha: 'sha9' });
        expect((await job()).status).toBe('awaiting_review');
    });

    it('partial results keep the normal path', async () => {
        const run = await addRun(1);
        await events.linkPr(REPO, pr(body(run.id, 'partial')));
        expect((await job()).status).toBe('pr_open');
        expect(parked).not.toHaveBeenCalled();
        expect(sent.map((e) => (e as { outcome?: string }).outcome)).toEqual(['partial']);
    });

    it('works without the optional services', async () => {
        const bare = new JobEventsService(jobs, runs, ds.getRepository(Project));
        const run = await addRun(1);
        await bare.linkPr(REPO, pr(body(run.id, 'blocked')));
        expect((await job()).status).toBe('parked');
    });

    describe('merged-without-work', () => {
        it('a blocked PR merged from parked is merged and flagged', async () => {
            const run = await addRun(1);
            await events.linkPr(REPO, pr(body(run.id, 'blocked')));
            expect(await events.prClosed(await job(), 7, true)).toMatch(/merged/);
            const j = await job();
            expect(j.status).toBe('merged');
            expect(j.mergedBlocked).toBe(true);
        });

        it('done, partial and no-result merges are not flagged', async () => {
            for (const result of [{ outcome: 'done', summary: 's' }, { outcome: 'partial', summary: 's' }, null] as const) {
                await jobs.update({ id: J1 }, { status: 'pr_open', mergedBlocked: false });
                await runs.delete({ jobId: J1 });
                await addRun(1, { result: result as never });
                await events.prClosed(await job(), 7, true);
                expect((await job()).mergedBlocked).toBe(false);
            }
        });

        it('only the latest attempt counts: a historical blocked attempt is ignored', async () => {
            await addRun(1, { result: { outcome: 'blocked', summary: 'old' } });
            await addRun(2, { result: { outcome: 'done', summary: 'ok' } });
            await jobs.update({ id: J1 }, { status: 'pr_open' });
            await events.prClosed(await job(), 7, true);
            expect((await job()).mergedBlocked).toBe(false);
        });

        it('a body edited after the merge keeps the flag in step with the stored result', async () => {
            const run = await addRun(1, { result: { outcome: 'done', summary: 'ok' } });
            await jobs.update({ id: J1 }, { status: 'pr_open' });
            await events.prClosed(await job(), 7, true);
            expect((await job()).mergedBlocked).toBe(false);
            await edit(run.id, body(run.id, 'blocked'));
            expect((await job()).mergedBlocked).toBe(true);
            await edit(run.id, body(run.id, 'done'));
            expect((await job()).mergedBlocked).toBe(false);
        });

        it('a closed (not merged) PR is never flagged', async () => {
            await addRun(1, { result: { outcome: 'blocked', summary: 'x' } });
            await jobs.update({ id: J1 }, { status: 'pr_open' });
            await events.prClosed(await job(), 7, false);
            expect((await job()).mergedBlocked).toBe(false);
        });
    });
});
