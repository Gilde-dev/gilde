import type { Job } from './api';

export interface DependencyLevels {
  /** levels[0] has no dependencies inside the feature; level n depends on level n-1 at most. */
  levels: Job[][];
  /** Jobs in a dependency cycle; they have no level. */
  cyclic: Job[];
  /** Dependencies that are not jobs of this feature, by job id. */
  outside: { job: Job; dependencyId: string }[];
  /** Human-readable remarks about cycles and outside dependencies. */
  notes: string[];
}

export function dependencyLevels(jobs: Job[]): DependencyLevels {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const outside: DependencyLevels['outside'] = [];
  const inside = new Map<string, string[]>();
  for (const j of jobs) {
    const deps: string[] = [];
    for (const d of j.dependsOn ?? []) {
      if (d !== j.id && byId.has(d)) deps.push(d);
      else if (d !== j.id) outside.push({ job: j, dependencyId: d });
      else deps.push(d); // a self-dependency is a cycle
    }
    inside.set(j.id, deps);
  }

  const level = new Map<string, number>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const j of jobs) {
      if (level.has(j.id)) continue;
      const deps = inside.get(j.id) ?? [];
      if (deps.every((d) => level.has(d))) {
        level.set(j.id, deps.length === 0 ? 0 : Math.max(...deps.map((d) => level.get(d) ?? 0)) + 1);
        progressed = true;
      }
    }
  }

  const levels: Job[][] = [];
  const cyclic: Job[] = [];
  for (const j of jobs) {
    const l = level.get(j.id);
    if (l === undefined) cyclic.push(j);
    else (levels[l] ??= []).push(j);
  }

  const notes: string[] = [];
  if (cyclic.length > 0) notes.push(`Dependency cycle between: ${cyclic.map((j) => j.title).join(', ')}.`);
  if (outside.length > 0) {
    notes.push(`Depends on jobs outside this feature: ${outside.map((o) => `${o.job.title} → ${o.dependencyId.slice(0, 8)}`).join(', ')}.`);
  }
  return { levels, cyclic, outside, notes };
}
