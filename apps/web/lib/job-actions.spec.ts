import { describe, expect, it } from 'vitest';
import { JOB_STATUSES, type Job } from './api';
import { canFixConflicts } from './job-actions';

describe('canFixConflicts', () => {
  const job = (over: Partial<Job>) => ({ status: 'awaiting_review', prNumber: 7, mergeConflict: true, ...over }) as Job;

  it.each(JOB_STATUSES)('%s', (status) => {
    expect(canFixConflicts(job({ status }))).toBe(status === 'pr_open' || status === 'awaiting_review');
  });

  it('needs a PR and a known conflict', () => {
    expect(canFixConflicts(job({ prNumber: null }))).toBe(false);
    expect(canFixConflicts(job({ mergeConflict: false }))).toBe(false);
  });
});
