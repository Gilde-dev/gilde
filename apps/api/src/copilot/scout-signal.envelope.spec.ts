import type { ScoutEvent } from '../scout-signal/scout-signal.events.js';
import { allowlistedPayload, envelopeFor, PAYLOAD_ALLOWLIST, SUMMARY_MAX } from './scout-signal.envelope.js';

const P = 'p1';
const events: Array<[ScoutEvent, string, string]> = [
    [{ type: 'run_outcome', outcome: 'blocked', jobId: 'j1', runId: 'r1', repoId: 'rp' }, 'run-blocked', 'high'],
    [{ type: 'run_outcome', outcome: 'partial', jobId: 'j1', runId: 'r1', repoId: 'rp' }, 'run-partial', 'high'],
    [{ type: 'job_parked', jobId: 'j1', repoId: 'rp', attempts: 2, cause: 'failure', headSha: 'abc' }, 'job-parked', 'high'],
    [{ type: 'changes_requested', jobId: 'j1', repoId: 'rp', feedbackId: 'f1', prNumber: 4 }, 'review-changes-requested', 'medium'],
    [{ type: 'lesson_created', lessonId: 'l1', jobId: 'j1' }, 'lesson-new', 'low'],
    [{ type: 'feature_done', featureId: 'ft1', doneAt: '2030-01-01T00:00:00.000Z' }, 'feature-done', 'low'],
    [{ type: 'job_merged', jobId: 'j1', repoId: 'rp' }, 'job-merged', 'low'],
];

describe('envelopeFor', () => {
    it.each(events)('%j maps to kind %s with priority %s, source gilde, bounded one line and allowlisted payload', (event, kind, priority) => {
        const envelope = envelopeFor(P, event, 'acme/api');
        expect(envelope).toMatchObject({ source: 'gilde', kind, priority });
        expect(envelope.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
        expect(envelope.summary).not.toMatch(/\n/);
        expect(Object.keys(envelope.payload).every((k) => (PAYLOAD_ALLOWLIST as readonly string[]).includes(k))).toBe(true);
        expect(Object.values(envelope.payload).every((v) => ['string', 'number', 'boolean'].includes(typeof v))).toBe(true);
        expect(envelope.dedupeKey).toBe(envelopeFor(P, event, 'acme/api').dedupeKey); // stable: no clock
    });

    it('gives different occurrences different keys and the same occurrence the same key', () => {
        const key = (e: ScoutEvent) => envelopeFor(P, e, null).dedupeKey;
        expect(key({ type: 'run_outcome', outcome: 'blocked', jobId: 'j', runId: 'r1', repoId: 'x' })).not.toBe(key({ type: 'run_outcome', outcome: 'partial', jobId: 'j', runId: 'r1', repoId: 'x' }));
        expect(key({ type: 'job_parked', jobId: 'j', repoId: 'x', attempts: 1, cause: 'failure', headSha: null })).not.toBe(key({ type: 'job_parked', jobId: 'j', repoId: 'x', attempts: 2, cause: 'failure', headSha: null }));
        // Reopening and completing a feature later is a new occurrence.
        expect(key({ type: 'feature_done', featureId: 'f', doneAt: '2030-01-01T00:00:00.000Z' })).not.toBe(key({ type: 'feature_done', featureId: 'f', doneAt: '2030-02-01T00:00:00.000Z' }));
    });

    it('drops anything outside the allowlist and bounds long values', () => {
        const payload = allowlistedPayload({ jobId: 'x'.repeat(500), task: 'secret task text', body: 'PR body', diff: '+++', reason: 'free text', prNumber: 3 });
        expect(Object.keys(payload).sort()).toEqual(['jobId', 'prNumber']);
        expect((payload.jobId as string).length).toBe(100);
    });

    it('contains no source text for any event type', () => {
        for (const [event] of events) {
            const text = JSON.stringify(envelopeFor(P, event, 'acme/api'));
            expect(text).not.toMatch(/task|diff|retro|prompt/i);
        }
    });
});
