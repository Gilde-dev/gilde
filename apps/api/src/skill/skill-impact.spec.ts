import { describe, expect, it } from 'vitest';

import type { RunOutcome } from './run-outcome.js';
import { computeSkillImpact, summarize, type ImpactRun } from './skill-impact.js';

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    result: 'done', ciFailed: false, revisionRounds: 0, merged: true, rejectedOrParked: false, cancelled: false,
    superseded: false, attempt: 1, tokens: null, costUsd: null, ...over,
});
const skill = (name: string, hash: string) => ({ name, hash, managedBy: 'gildeboek@v1' });
const run = (repoId: string, day: number, skills: ImpactRun['skills'], o: RunOutcome | null = outcome()): ImpactRun => ({
    repoId, createdAt: new Date(Date.UTC(2026, 0, day)), skills, outcome: o,
});
const many = (n: number, make: (i: number) => ImpactRun) => Array.from({ length: n }, (_, i) => make(i));

describe('summarize', () => {
    it('counts and rates a group at the threshold', () => {
        const g = summarize([
            outcome({ result: 'done', revisionRounds: 2, tokens: 100 }),
            outcome({ result: 'partial', merged: false, rejectedOrParked: true, ciFailed: true, tokens: 300 }),
            outcome({ result: 'blocked', merged: false, revisionRounds: 1 }),
            outcome({ result: 'none', cancelled: true, merged: false }),
        ], 4);
        expect(g).toEqual({
            n: 4, insufficient: false,
            counts: { done: 1, partial: 1, blocked: 1, merged: 1, rejectedOrParked: 1, ciFailed: 1 },
            rates: { done: 0.25, partial: 0.25, blocked: 0.25, merged: 0.25, rejectedOrParked: 0.25, ciFailed: 0.25 },
            avgRevisionRounds: 0.75, medianTokens: 200, tokensN: 2,
        });
    });

    it('is insufficient below the minimum: n and counts, no rates, average or median', () => {
        const g = summarize([outcome({ tokens: 5 }), outcome()], 3);
        expect(g).toMatchObject({ n: 2, insufficient: true, rates: null, avgRevisionRounds: null, medianTokens: null, tokensN: 1 });
        expect(g.counts.done).toBe(2);
    });

    it('an empty group is insufficient and has a null median', () => {
        expect(summarize([], 1)).toMatchObject({ n: 0, insufficient: true, rates: null });
        expect(summarize([outcome()], 1)).toMatchObject({ insufficient: false, medianTokens: null });
    });

    it('takes the middle of an odd and the mean of the middle two of an even number of token values', () => {
        expect(summarize([1, 9, 5].map((tokens) => outcome({ tokens })), 1).medianTokens).toBe(5);
        expect(summarize([1, 9, 5, 7].map((tokens) => outcome({ tokens })), 1).medianTokens).toBe(6);
    });
});

describe('computeSkillImpact', () => {
    it('compares runs with an exact version to runs in the same repos without the skill, ignoring other repos', () => {
        const runs = [
            ...many(3, () => run('r1', 5, [skill('pnpm', 'h1')])),
            ...many(2, () => run('r1', 1, [], outcome({ result: 'blocked', merged: false }))),
            ...many(4, () => run('r2', 1, [], outcome({ result: 'partial' }))),
            run('r1', 2, [skill('other', 'x')]),
        ];
        const { skills } = computeSkillImpact(runs, { days: 30, minRuns: 1 });
        const pnpm = skills.find((s) => s.name === 'pnpm')!.versions[0];
        expect(pnpm.with.n).toBe(3);
        // r1 runs without pnpm: 2 blocked plus the run that has only `other`; r2 is not a repo that had the skill.
        expect(pnpm.without.n).toBe(3);
        expect(pnpm.without.counts.blocked).toBe(2);
        expect(pnpm.without.counts.partial).toBe(0);
    });

    it('excludes unfinished runs from every group', () => {
        const runs = [run('r', 1, [skill('s', 'h')]), run('r', 2, [skill('s', 'h')], null), run('r', 3, [], null), run('r', 4, [])];
        const v = computeSkillImpact(runs, { days: 30, minRuns: 1 }).skills[0].versions[0];
        expect(v.with.n).toBe(1);
        expect(v.without.n).toBe(1);
    });

    it('does not count runs of a different version as "without"', () => {
        const runs = [run('r', 1, [skill('s', 'old')]), run('r', 9, [skill('s', 'new')])];
        const [old, next] = computeSkillImpact(runs, { days: 30, minRuns: 1 }).skills[0].versions;
        expect(old.without.n).toBe(0);
        expect(next.without.n).toBe(0);
    });

    it('lists versions per skill name in the order they were first seen, with first and last seen', () => {
        const runs = [
            run('r', 10, [skill('s', 'b')]), run('r', 3, [skill('s', 'a')]), run('r', 12, [skill('s', 'b')]), run('r', 20, [skill('s', 'a')]),
            run('r', 5, [skill('a-skill', 'z')]),
        ];
        const { skills } = computeSkillImpact(runs, { days: 30, minRuns: 1 });
        expect(skills.map((s) => s.name)).toEqual(['a-skill', 's']);
        const s = skills[1];
        expect(s.versions.map((v) => v.hash)).toEqual(['a', 'b']);
        expect(s.versions[0].firstSeenAt).toBe('2026-01-03T00:00:00.000Z');
        expect(s.versions[0].lastSeenAt).toBe('2026-01-20T00:00:00.000Z');
        expect(s.versions[1].firstSeenAt).toBe('2026-01-10T00:00:00.000Z');
    });

    it('applies the minimum run threshold to each group on its own', () => {
        const runs = [...many(10, () => run('r', 1, [skill('s', 'h')])), ...many(9, () => run('r', 2, []))];
        const v = computeSkillImpact(runs, { days: 30, minRuns: 10 }).skills[0].versions[0];
        expect(v.with).toMatchObject({ n: 10, insufficient: false });
        expect(v.with.rates?.done).toBe(1);
        expect(v.without).toMatchObject({ n: 9, insufficient: true, rates: null });
    });

    it('echoes days and minRuns and is empty without skills', () => {
        expect(computeSkillImpact([run('r', 1, [])], { days: 7, minRuns: 4 })).toEqual({ days: 7, minRuns: 4, skills: [] });
    });
});
