import { z } from 'zod';

import { CreateFeatureSchema } from '../feature/feature.dto.js';
import { CreateJobSchema } from '../job/job.dto.js';

/** A job in a draft; `key` is local to the draft and `dependsOn` lists keys of other jobs in it. */
export const PlanJobSchema = z.object({
    key: z.string().trim().min(1).max(60),
    repoId: z.string().uuid(),
    title: CreateJobSchema.shape.title,
    task: CreateJobSchema.shape.task,
    acceptanceCriteria: z.array(z.string().trim().min(3)).min(1).max(20),
    dependsOn: z.array(z.string().trim().min(1)).max(20).default([]),
});

export const FeaturePlanSchema = z.object({
    projectId: z.string().uuid(),
    title: CreateFeatureSchema.shape.title,
    spec: z.string().trim().min(1).max(20000),
    acceptanceCriteria: z.array(z.string().trim().min(3)).min(1).max(20),
    jobs: z.array(PlanJobSchema).min(1).max(30),
});

export type FeaturePlan = z.infer<typeof FeaturePlanSchema>;
export type PlanJob = FeaturePlan['jobs'][number];

/** Problems of the draft that do not need the database: duplicate keys, unknown keys, self-dependencies, cycles. */
export function graphProblems(jobs: Pick<PlanJob, 'key' | 'dependsOn'>[]): string[] {
    const problems: string[] = [];
    const keys = new Set<string>();
    for (const j of jobs) {
        if (keys.has(j.key)) problems.push(`Duplicate job key "${j.key}"`);
        keys.add(j.key);
    }
    for (const j of jobs) {
        if (new Set(j.dependsOn).size !== j.dependsOn.length) problems.push(`Job "${j.key}" lists a dependency twice`);
        for (const dep of j.dependsOn) {
            if (dep === j.key) problems.push(`Job "${j.key}" depends on itself`);
            else if (!keys.has(dep)) problems.push(`Job "${j.key}" depends on unknown key "${dep}"`);
        }
    }
    if (problems.length) return problems;
    const cycle = findCycle(jobs);
    return cycle ? [`Dependency cycle: ${cycle.join(' -> ')}`] : [];
}

function findCycle(jobs: Pick<PlanJob, 'key' | 'dependsOn'>[]): string[] | null {
    const deps = new Map(jobs.map((j) => [j.key, j.dependsOn]));
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const visit = (key: string): string[] | null => {
        if (state.get(key) === 'done') return null;
        if (state.get(key) === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
        state.set(key, 'visiting');
        stack.push(key);
        for (const dep of deps.get(key) ?? []) {
            const cycle = visit(dep);
            if (cycle) return cycle;
        }
        stack.pop();
        state.set(key, 'done');
        return null;
    };
    for (const j of jobs) {
        const cycle = visit(j.key);
        if (cycle) return cycle;
    }
    return null;
}

/** Jobs ordered so every job comes after the jobs it depends on. Assumes a valid graph. */
export function dependencyOrder<T extends Pick<PlanJob, 'key' | 'dependsOn'>>(jobs: T[]): T[] {
    const byKey = new Map(jobs.map((j) => [j.key, j]));
    const ordered: T[] = [];
    const seen = new Set<string>();
    const visit = (j: T) => {
        if (seen.has(j.key)) return;
        seen.add(j.key);
        for (const dep of j.dependsOn) visit(byKey.get(dep)!);
        ordered.push(j);
    };
    jobs.forEach(visit);
    return ordered;
}
