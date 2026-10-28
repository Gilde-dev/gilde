export const DEFAULT_SKILL_IMPACT_MIN_RUNS = 10;

export interface SkillImpactConfig {
    /** A group with fewer finished runs reports `insufficient` and no rates. */
    minRuns: number;
}

export const SKILL_IMPACT_CONFIG = Symbol('SKILL_IMPACT_CONFIG');

/** Unset: the default. Set: a positive safe integer in plain digits; anything else throws (fail closed, never a silent default). */
export function skillImpactConfig(env: NodeJS.ProcessEnv = process.env): SkillImpactConfig {
    const raw = env.SKILL_IMPACT_MIN_RUNS;
    if (raw === undefined) return { minRuns: DEFAULT_SKILL_IMPACT_MIN_RUNS };
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('SKILL_IMPACT_MIN_RUNS must be a positive integer, got an invalid value');
    return { minRuns: value };
}
