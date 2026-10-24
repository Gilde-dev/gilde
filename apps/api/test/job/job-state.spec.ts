import { describe, expect, it } from 'vitest';
import { JOB_STATUSES, TERMINAL, nextStatus, retryOrPark } from '../../src/job/job-state.js';

describe('job state machine', () => {
    it('walks the happy path', () => {
        expect(nextStatus('queued', 'fire')).toBe('dispatched');
        expect(nextStatus('dispatched', 'pr_activity')).toBe('pr_open');
        expect(nextStatus('pr_open', 'ci_passed')).toBe('awaiting_review');
        expect(nextStatus('awaiting_review', 'merged')).toBe('merged');
    });

    it('goes back to pr_open when the agent pushes after green CI', () => {
        expect(nextStatus('awaiting_review', 'pr_activity')).toBe('pr_open');
    });

    it('cannot fire a job twice', () => {
        expect(nextStatus('dispatched', 'fire')).toBeNull();
    });

    it('never leaves a terminal status', () => {
        const events = ['fire', 'pr_activity', 'ci_passed', 'retry', 'park', 'merged', 'closed', 'cancel', 'manual_retry', 'enqueue', 'triage'] as const;
        for (const status of TERMINAL) for (const e of events) expect(nextStatus(status, e)).toBeNull();
    });

    it('ends the job when the PR is merged or closed, even while queued or dispatched', () => {
        for (const s of ['queued', 'dispatched'] as const) {
            expect(nextStatus(s, 'merged')).toBe('merged');
            expect(nextStatus(s, 'closed')).toBe('rejected');
        }
    });

    it('only parked jobs can be retried manually', () => {
        for (const s of JOB_STATUSES) {
            expect(nextStatus(s, 'manual_retry')).toBe(s === 'parked' ? 'queued' : null);
        }
    });

    it('parks when attempts are used up', () => {
        expect(retryOrPark(1, 3)).toBe('retry');
        expect(retryOrPark(3, 3)).toBe('park');
    });

    it('moves between triage and queued, and triage can be cancelled', () => {
        expect(nextStatus('triage', 'enqueue')).toBe('queued');
        expect(nextStatus('triage', 'cancel')).toBe('cancelled');
        expect(nextStatus('queued', 'triage')).toBe('triage');
    });

    it('rejects every other transition into or out of triage', () => {
        for (const e of ['fire', 'pr_activity', 'ci_passed', 'retry', 'park', 'merged', 'closed', 'manual_retry', 'triage'] as const) {
            expect(nextStatus('triage', e)).toBeNull();
        }
        for (const s of JOB_STATUSES) {
            if (s !== 'queued') expect(nextStatus(s, 'triage')).toBeNull();
            if (s !== 'triage') expect(nextStatus(s, 'enqueue')).toBeNull();
        }
    });
});
