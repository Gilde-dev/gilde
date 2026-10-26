import { describe, expect, it } from 'vitest';
import type { Job, JobStatus } from './api';
import { activeJobCount, boardStats } from './job-stats';

const job = (status: JobStatus, extra: Partial<Job> = {}) => ({ status, needsApproval: false, failedDependency: undefined, ...extra }) as Job;

describe('boardStats', () => {
  it('counts in progress, awaiting review, triage and needs attention', () => {
    const jobs = [
      job('dispatched'), job('pr_open'), job('pr_open'), job('awaiting_review'), job('triage'), job('triage'), job('triage'),
      job('merged'), job('queued'),
    ];
    expect(boardStats(jobs)).toEqual({ inProgress: 3, awaitingReview: 1, triage: 3, needsAttention: 0 });
  });

  it('counts a job once in Needs attention even when every predicate holds', () => {
    const all = job('parked', { needsApproval: true, failedDependency: true });
    const jobs = [all, job('queued', { needsApproval: true }), job('queued', { failedDependency: true }), job('parked'), job('queued')];
    expect(boardStats(jobs).needsAttention).toBe(4);
  });

  it('lets cards overlap: an awaiting_review job that needs approval is in both', () => {
    const stats = boardStats([job('awaiting_review', { needsApproval: true })]);
    expect(stats).toMatchObject({ awaitingReview: 1, needsAttention: 1 });
  });

  it('is zero for an empty list', () => {
    expect(boardStats([])).toEqual({ inProgress: 0, awaitingReview: 0, triage: 0, needsAttention: 0 });
  });
});

describe('activeJobCount', () => {
  it('counts queued, dispatched, pr_open and awaiting_review', () => {
    const jobs = (['triage', 'queued', 'dispatched', 'pr_open', 'awaiting_review', 'parked', 'merged', 'rejected', 'cancelled'] as JobStatus[]).map((s) => job(s));
    expect(activeJobCount(jobs)).toBe(4);
  });
});
