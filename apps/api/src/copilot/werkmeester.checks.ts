import { hasFetchLine } from './feature-plan-context.js';

export interface CheckedJob { key: string; title: string; task: string; acceptanceCriteria: string[]; dependsOn: string[] }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Problems of a plan that the Werkmeester can fix itself; each names the job or criterion and says what to change. */
export function planProblems(criteria: { id: string }[], jobs: CheckedJob[]): string[] {
    return [...uncoveredCriteria(criteria, jobs), ...missingFetchLine(jobs), ...undeclaredDependencies(jobs)];
}

/** Every `AC-n` of the version must be mentioned (as a whole token) in the task or criteria of at least one job. */
function uncoveredCriteria(criteria: { id: string }[], jobs: CheckedJob[]): string[] {
    const text = jobs.map((j) => `${j.task}\n${j.acceptanceCriteria.join('\n')}`).join('\n');
    return criteria
        .filter((c) => !new RegExp(`(?<![\\w-])${escapeRegExp(c.id)}(?!\\w)`, 'i').test(text))
        .map((c) => `${c.id} of the spec is not mentioned in any job's task or acceptance criteria; cover it in a job and name it (e.g. "This job covers ${c.id}")`);
}

function missingFetchLine(jobs: CheckedJob[]): string[] {
    return jobs
        .filter((j) => !hasFetchLine(j.task))
        .map((j) => `Job "${j.key}": the task must start with \`First run \`git fetch origin && git rebase origin/main\`\` (then the rest of the task)`);
}

/**
 * A job that names another job of the plan, by its key in quotes or backticks or by its title, builds on it; that needs a
 * (possibly indirect) dependency. A job's own title does not count.
 */
function undeclaredDependencies(jobs: CheckedJob[]): string[] {
    const byKey = new Map(jobs.map((j) => [j.key, j]));
    const reach = (key: string, seen = new Set<string>()): Set<string> => {
        for (const dep of byKey.get(key)?.dependsOn ?? []) {
            if (!seen.has(dep)) { seen.add(dep); reach(dep, seen); }
        }
        return seen;
    };
    const problems: string[] = [];
    for (const job of jobs) {
        const covered = reach(job.key);
        const task = `${job.task}\n${job.acceptanceCriteria.join('\n')}`.toLowerCase();
        for (const other of jobs) {
            if (other.key === job.key || covered.has(other.key)) continue;
            const quotedKey = new RegExp(`[\`"'“‘]${escapeRegExp(other.key.toLowerCase())}[\`"'”’]`).test(task);
            const title = other.title.trim().length >= 3 && task.includes(other.title.trim().toLowerCase());
            if (quotedKey || title) {
                problems.push(`Job "${job.key}" mentions job "${other.key}" (${other.title}) but does not list it in dependsOn; add "${other.key}" to dependsOn if it builds on that job, otherwise stop naming it`);
            }
        }
    }
    return problems;
}
