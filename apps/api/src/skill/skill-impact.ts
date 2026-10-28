import type { ImpactGroupDto, SkillImpactResponseDto } from './skill-impact.dto.js';
import type { RunOutcome } from './run-outcome.js';

/** A run with a captured context; `outcome` is null while it is unfinished. */
export interface ImpactRun {
    repoId: string;
    createdAt: Date;
    skills: { name: string; hash: string; managedBy: string | null }[];
    outcome: RunOutcome | null;
}

const rate = (n: number, total: number) => n / total;

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(outcomes: RunOutcome[], minRuns: number): ImpactGroupDto {
    const n = outcomes.length;
    const count = (pred: (o: RunOutcome) => boolean) => outcomes.filter(pred).length;
    const counts = {
        done: count((o) => o.result === 'done'),
        partial: count((o) => o.result === 'partial'),
        blocked: count((o) => o.result === 'blocked'),
        merged: count((o) => o.merged),
        rejectedOrParked: count((o) => o.rejectedOrParked),
        ciFailed: count((o) => o.ciFailed),
    };
    const tokens = outcomes.flatMap((o) => (o.tokens === null ? [] : [o.tokens]));
    const insufficient = n < minRuns;
    return {
        n,
        insufficient,
        counts,
        rates: insufficient ? null : {
            done: rate(counts.done, n), partial: rate(counts.partial, n), blocked: rate(counts.blocked, n),
            merged: rate(counts.merged, n), rejectedOrParked: rate(counts.rejectedOrParked, n), ciFailed: rate(counts.ciFailed, n),
        },
        avgRevisionRounds: insufficient ? null : outcomes.reduce((sum, o) => sum + o.revisionRounds, 0) / n,
        medianTokens: insufficient ? null : median(tokens),
        tokensN: tokens.length,
    };
}

/**
 * Descriptive comparison per skill version: finished runs with that exact version, and finished runs in the same repos
 * that had no version of the skill. Not an effect estimate: nothing here controls for job difficulty or other changes.
 */
export function computeSkillImpact(runs: ImpactRun[], opts: { days: number; minRuns: number }): SkillImpactResponseDto {
    // name -> hash -> the runs that had it
    const byName = new Map<string, Map<string, { managedBy: string | null; runs: ImpactRun[] }>>();
    for (const run of runs) {
        for (const s of run.skills) {
            const versions = byName.get(s.name) ?? new Map();
            byName.set(s.name, versions);
            const entry = versions.get(s.hash) ?? { managedBy: s.managedBy, runs: [] };
            versions.set(s.hash, entry);
            entry.runs.push(run);
        }
    }

    const skills = [...byName.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, versions]) => {
            const list = [...versions.entries()].map(([hash, v]) => {
                const times = v.runs.map((r) => r.createdAt.getTime());
                return { hash, managedBy: v.managedBy, runs: v.runs, first: Math.min(...times), last: Math.max(...times) };
            }).sort((a, b) => a.first - b.first || (a.hash < b.hash ? -1 : 1));
            return {
                name,
                versions: list.map((v) => {
                    const repoIds = new Set(v.runs.map((r) => r.repoId));
                    const without = runs.filter((r) => repoIds.has(r.repoId) && !r.skills.some((s) => s.name === name));
                    return {
                        hash: v.hash,
                        managedBy: v.managedBy,
                        firstSeenAt: new Date(v.first).toISOString(),
                        lastSeenAt: new Date(v.last).toISOString(),
                        with: summarize(finished(v.runs), opts.minRuns),
                        without: summarize(finished(without), opts.minRuns),
                    };
                }),
            };
        });
    return { days: opts.days, minRuns: opts.minRuns, skills };
}

const finished = (runs: ImpactRun[]): RunOutcome[] => runs.flatMap((r) => (r.outcome ? [r.outcome] : []));
