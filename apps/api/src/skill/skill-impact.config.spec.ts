import { describe, expect, it } from 'vitest';

import { skillImpactConfig } from './skill-impact.config.js';

describe('skillImpactConfig', () => {
    it('defaults to 10', () => expect(skillImpactConfig({})).toEqual({ minRuns: 10 }));
    it('reads a positive integer', () => expect(skillImpactConfig({ SKILL_IMPACT_MIN_RUNS: '25' })).toEqual({ minRuns: 25 }));
    it.each(['0', '-1', '1.5', 'abc', '', ' 5', '1e3', '99999999999999999999'])('fails closed on %j without echoing it', (raw) => {
        expect(() => skillImpactConfig({ SKILL_IMPACT_MIN_RUNS: raw })).toThrow(/SKILL_IMPACT_MIN_RUNS must be a positive integer/);
        try { skillImpactConfig({ SKILL_IMPACT_MIN_RUNS: raw }); } catch (e) { if (raw) expect((e as Error).message).not.toContain(raw); }
    });
});
