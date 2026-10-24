import { describe, expect, it } from 'vitest';

import { FEATURE_STATUSES, nextFeatureStatus, type FeatureEvent, type FeatureStatus } from './feature-state.js';

const ALLOWED: [FeatureStatus, FeatureEvent, FeatureStatus][] = [
    ['draft', 'start', 'active'],
    ['draft', 'cancel', 'cancelled'],
    ['active', 'done', 'done'],
    ['active', 'cancel', 'cancelled'],
    ['done', 'reopen', 'active'],
];

describe('feature state machine', () => {
    it.each(ALLOWED)('%s --%s--> %s', (from, event, to) => {
        expect(nextFeatureStatus(from, event)).toBe(to);
    });

    it('rejects every other transition', () => {
        const events: FeatureEvent[] = ['start', 'done', 'cancel', 'reopen'];
        for (const from of FEATURE_STATUSES) {
            for (const event of events) {
                if (ALLOWED.some(([f, e]) => f === from && e === event)) continue;
                expect(nextFeatureStatus(from, event), `${from} ${event}`).toBeNull();
            }
        }
    });
});
