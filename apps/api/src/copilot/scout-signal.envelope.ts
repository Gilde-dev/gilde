import type { ScoutEvent } from '../scout-signal/scout-signal.events.js';

export const SCOUT_SIGNAL_SOURCE = 'gilde';
export type ScoutPriority = 'high' | 'medium' | 'low';

export interface ScoutEnvelope {
    source: typeof SCOUT_SIGNAL_SOURCE;
    kind: string;
    priority: ScoutPriority;
    /** One bounded line with ids; never source text. */
    summary: string;
    payload: Record<string, string | number | boolean>;
    dedupeKey: string;
}

export const SUMMARY_MAX = 240;
const PAYLOAD_VALUE_MAX = 100;

/** The only payload keys a signal may carry: ids, status and repo name. */
export const PAYLOAD_ALLOWLIST = ['projectId', 'jobId', 'runId', 'featureId', 'lessonId', 'feedbackId', 'repoId', 'repo', 'outcome', 'status', 'cause', 'attempt', 'prNumber'] as const;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);

/** Keeps only allowlisted keys with short scalar values. */
export function allowlistedPayload(input: Record<string, unknown>): ScoutEnvelope['payload'] {
    const out: ScoutEnvelope['payload'] = {};
    for (const key of PAYLOAD_ALLOWLIST) {
        const value = input[key];
        if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
        else if (typeof value === 'string') out[key] = value.slice(0, PAYLOAD_VALUE_MAX);
    }
    return out;
}

/**
 * Maps one event to its envelope: kind and priority per the event type, a stable dedupeKey from the identity of the
 * occurrence (ids, attempt, outcome; never the clock) and a payload of ids, status and repo only.
 * `repo` is the repo's full name when known.
 */
export function envelopeFor(projectId: string, event: ScoutEvent, repo: string | null): ScoutEnvelope {
    const where = repo ? ` in ${repo}` : '';
    const base = { projectId, repo: repo ?? undefined };
    switch (event.type) {
        case 'run_outcome':
            return {
                source: SCOUT_SIGNAL_SOURCE, kind: `run-${event.outcome}`, priority: 'high',
                summary: oneLine(`Run ${event.runId} of job ${event.jobId} ended ${event.outcome}${where}`),
                payload: allowlistedPayload({ ...base, jobId: event.jobId, runId: event.runId, repoId: event.repoId, outcome: event.outcome }),
                dedupeKey: `run-outcome:${event.runId}:${event.outcome}`,
            };
        case 'job_parked':
            return {
                source: SCOUT_SIGNAL_SOURCE, kind: 'job-parked', priority: 'high',
                summary: oneLine(`Job ${event.jobId} was parked after attempt ${event.attempts} (${event.cause})${where}`),
                payload: allowlistedPayload({ ...base, jobId: event.jobId, repoId: event.repoId, status: 'parked', cause: event.cause, attempt: event.attempts }),
                dedupeKey: `job-parked:${event.jobId}:a${event.attempts}:${event.headSha ?? 'none'}:${event.cause}`,
            };
        case 'changes_requested':
            return {
                source: SCOUT_SIGNAL_SOURCE, kind: 'review-changes-requested', priority: 'medium',
                summary: oneLine(`Changes requested on PR #${event.prNumber} of job ${event.jobId}${where}`),
                payload: allowlistedPayload({ ...base, jobId: event.jobId, repoId: event.repoId, feedbackId: event.feedbackId, prNumber: event.prNumber, status: 'changes_requested' }),
                dedupeKey: `review-changes-requested:${event.feedbackId}`,
            };
        case 'lesson_created':
            return {
                source: SCOUT_SIGNAL_SOURCE, kind: 'lesson-new', priority: 'low',
                summary: oneLine(`New lesson ${event.lessonId}${event.jobId ? ` from job ${event.jobId}` : ''}`),
                payload: allowlistedPayload({ projectId, lessonId: event.lessonId, jobId: event.jobId ?? undefined, status: 'candidate' }),
                dedupeKey: `lesson-new:${event.lessonId}`,
            };
        case 'feature_done':
            return {
                source: SCOUT_SIGNAL_SOURCE, kind: 'feature-done', priority: 'low',
                summary: oneLine(`Feature ${event.featureId} was closed as done`),
                payload: allowlistedPayload({ projectId, featureId: event.featureId, status: 'done' }),
                dedupeKey: `feature-done:${event.featureId}:${event.doneAt}`,
            };
        case 'job_merged':
            return {
                source: SCOUT_SIGNAL_SOURCE, kind: 'job-merged', priority: 'low',
                summary: oneLine(`Job ${event.jobId} was merged${where}`),
                payload: allowlistedPayload({ ...base, jobId: event.jobId, repoId: event.repoId, status: 'merged' }),
                dedupeKey: `job-merged:${event.jobId}`,
            };
    }
}

/** The repo id of an event, when it has one (used to look the repo name up). */
export const eventRepoId = (event: ScoutEvent): string | null => ('repoId' in event ? event.repoId : null);
