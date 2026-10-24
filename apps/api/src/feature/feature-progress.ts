import { JOB_STATUSES, type JobStatus } from '../job/job-state.js';
import type { FeatureProgressDto } from './feature.dto.js';
import type { Feature } from './feature.entity.js';

/** One group of a feature's jobs, as returned by the progress query. */
export interface StatusGroup {
    status: JobStatus;
    count: number;
    attempts: number;
}

export function emptyCounts(): Record<JobStatus, number> {
    return Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
}

/** Cancelled jobs are dropped from the total: a feature is done when everything that still counts is merged. */
export function buildProgress(feature: Feature, groups: StatusGroup[], now: Date = new Date()): FeatureProgressDto {
    const countByStatus = emptyCounts();
    let attempts = 0;
    for (const g of groups) {
        countByStatus[g.status] += g.count;
        attempts += g.attempts;
    }
    const total = JOB_STATUSES.reduce((sum, s) => (s === 'cancelled' ? sum : sum + countByStatus[s]), 0);
    const merged = countByStatus.merged;
    const end = feature.status === 'active' ? now : feature.doneAt;
    const leadTimeMinutes = feature.startedAt && end
        ? Math.max(0, Math.round((end.getTime() - feature.startedAt.getTime()) / 60_000))
        : null;
    return {
        total,
        countByStatus,
        merged,
        readyToClose: feature.status === 'active' && total > 0 && merged === total,
        attempts,
        leadTimeMinutes,
    };
}
