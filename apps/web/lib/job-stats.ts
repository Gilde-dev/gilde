import type { Job } from './api';

/** Statuses the sidebar's Board badge counts. */
const ACTIVE: Job['status'][] = ['queued', 'dispatched', 'pr_open', 'awaiting_review'];

/** Jobs of the given list that are queued, running, have a PR open or await review. */
export const activeJobCount = (jobs: Job[]): number => jobs.filter((j) => ACTIVE.includes(j.status)).length;

export interface BoardStats {
  inProgress: number;
  awaitingReview: number;
  triage: number;
  needsAttention: number;
}

/** A job needs attention when it is parked, awaits approval or has a failed dependency. */
export const needsAttention = (j: Job): boolean => j.status === 'parked' || j.needsApproval || j.failedDependency === true;

/**
 * The four board counts, from the loaded (unfiltered) job list only. Cards may overlap (an awaiting_review job
 * that needs approval is in two), but a job is counted once within a card.
 */
export function boardStats(jobs: Job[]): BoardStats {
  return {
    inProgress: jobs.filter((j) => j.status === 'dispatched' || j.status === 'pr_open').length,
    awaitingReview: jobs.filter((j) => j.status === 'awaiting_review').length,
    triage: jobs.filter((j) => j.status === 'triage').length,
    needsAttention: jobs.filter(needsAttention).length,
  };
}
