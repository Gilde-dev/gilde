import { describe, expect, it } from 'vitest';

import { parseExhaustedBackoffMinutes } from './executor-exhaustion.js';

describe('parseExhaustedBackoffMinutes', () => {
    it('defaults to 60 and accepts integers', () => {
        expect(parseExhaustedBackoffMinutes({})).toBe(60);
        expect(parseExhaustedBackoffMinutes({ EXECUTOR_EXHAUSTED_BACKOFF_MINUTES: ' 15 ' })).toBe(15);
    });

    it.each(['0', '-5', '1.5', 'abc', '10081', '1e3'])('rejects %s so startup fails closed', (value) => {
        expect(() => parseExhaustedBackoffMinutes({ EXECUTOR_EXHAUSTED_BACKOFF_MINUTES: value })).toThrow(/EXECUTOR_EXHAUSTED_BACKOFF_MINUTES/);
    });
});
