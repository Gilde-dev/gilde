import { describe, expect, it } from 'vitest';

import { JOB_STATUSES } from '../job/job-state.js';

import { classifyRun, isFinished, type RunFacts } from './run-outcome.js';

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
    attempt: 1, resultOutcome: 'done', ciConclusion: 'success', jobStatus: 'merged', jobMergedBlocked: false,
    revisionRounds: 0, latestAttempt: 1, tokens: null, costUsd: null, ...over,
});

describe('classifyRun', () => {
    it('is unfinished while the job is in flight on its latest attempt', () => {
        for (const jobStatus of ['triage', 'queued', 'dispatched', 'pr_open', 'awaiting_review'] as const) {
            expect(classifyRun(facts({ jobStatus })), jobStatus).toBeNull();
            expect(isFinished(facts({ jobStatus }))).toBe(false);
        }
    });

    it('is finished in every end state', () => {
        for (const jobStatus of ['merged', 'rejected', 'parked', 'cancelled'] as const) expect(classifyRun(facts({ jobStatus })), jobStatus).not.toBeNull();
    });

    it('is finished when a later attempt superseded it, whatever the job status', () => {
        for (const jobStatus of JOB_STATUSES) {
            const o = classifyRun(facts({ jobStatus, attempt: 1, latestAttempt: 2 }));
            expect(o?.superseded, jobStatus).toBe(true);
        }
        expect(classifyRun(facts({ jobStatus: 'merged' }))?.superseded).toBe(false);
    });

    it.each([['done'], ['partial'], ['blocked'], [null]] as const)('maps the result outcome %s', (resultOutcome) => {
        expect(classifyRun(facts({ resultOutcome }))?.result).toBe(resultOutcome ?? 'none');
    });

    it('marks CI failed for every non passing conclusion and not for passing or missing ones', () => {
        for (const c of ['failure', 'timed_out', 'cancelled', 'action_required', 'unknown']) expect(classifyRun(facts({ ciConclusion: c }))?.ciFailed, c).toBe(true);
        for (const c of ['success', 'neutral', 'skipped', null]) expect(classifyRun(facts({ ciConclusion: c }))?.ciFailed, String(c)).toBe(false);
    });

    it('counts a merged job as merged only when it was not merged blocked', () => {
        expect(classifyRun(facts())?.merged).toBe(true);
        expect(classifyRun(facts({ jobMergedBlocked: true }))?.merged).toBe(false);
        expect(classifyRun(facts({ jobStatus: 'rejected' }))?.merged).toBe(false);
    });

    it('classifies the end state of the job', () => {
        const end = (jobStatus: RunFacts['jobStatus']) => {
            const o = classifyRun(facts({ jobStatus }))!;
            return { rejectedOrParked: o.rejectedOrParked, cancelled: o.cancelled };
        };
        expect(end('rejected')).toEqual({ rejectedOrParked: true, cancelled: false });
        expect(end('parked')).toEqual({ rejectedOrParked: true, cancelled: false });
        expect(end('cancelled')).toEqual({ rejectedOrParked: false, cancelled: true });
        expect(end('merged')).toEqual({ rejectedOrParked: false, cancelled: false });
    });

    it('carries attempt, revision rounds, tokens and cost through', () => {
        expect(classifyRun(facts({ attempt: 2, latestAttempt: 2, revisionRounds: 3, tokens: 1200, costUsd: 0.5 }))).toMatchObject({
            attempt: 2, revisionRounds: 3, tokens: 1200, costUsd: 0.5,
        });
    });
});
