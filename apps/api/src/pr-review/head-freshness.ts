import type { GitHubPort, GitHubPull, GitHubWorkflowRun } from '../github/github.port.js';

const CI_OK = new Set(['success', 'neutral', 'skipped']);

export interface CiPolicy {
    /** A tracked workflow that gates readiness (CI, not the protected-path gates). */
    isCi(name: string): boolean;
}

/** The tracked CI workflows, configured like `JobEventsService` does (`GILDE_CI_WORKFLOWS` / `GILDE_GATE_WORKFLOWS`). */
export function ciPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): CiPolicy {
    const names = (raw: string | undefined, fallback: string) => new Set((raw ?? fallback).split(',').map((n) => n.trim()).filter(Boolean));
    const ci = names(env.GILDE_CI_WORKFLOWS, 'CI');
    const gates = names(env.GILDE_GATE_WORKFLOWS, 'Gates');
    return { isCi: (n) => ci.has(n) && !gates.has(n) };
}

/**
 * Fresh GitHub facts for a head: the PR is open, not a draft and still at the head; every tracked CI workflow of the head has
 * a completed, passing newest run. One stale success never outweighs a failing or running newer run.
 */
export async function checkHeadFresh(
    github: GitHubPort, fullName: string, prNumber: number, headSha: string, ci: CiPolicy,
): Promise<{ ok: true; pull: GitHubPull } | { ok: false; why: string }> {
    const pull = await github.getPull(fullName, prNumber);
    if (pull.state !== 'open') return { ok: false, why: `PR #${pull.number} is not open` };
    if (pull.draft === true) return { ok: false, why: `PR #${pull.number} is a draft` };
    if (pull.headSha !== headSha) return { ok: false, why: `PR #${pull.number} moved to ${pull.headSha.slice(0, 7)}` };
    const runs = await github.listWorkflowRuns(fullName, pull.headSha);
    const newest = new Map<string, GitHubWorkflowRun>();
    for (const run of runs) if (ci.isCi(run.name) && !newest.has(run.name)) newest.set(run.name, run);
    if (newest.size === 0) return { ok: false, why: 'no CI run is visible for the head' };
    for (const run of newest.values()) {
        if (run.status !== 'completed') return { ok: false, why: `CI workflow ${run.name} is still running` };
        if (!CI_OK.has(run.conclusion ?? '')) return { ok: false, why: `CI workflow ${run.name} is ${run.conclusion ?? 'unknown'}` };
    }
    return { ok: true, pull };
}
