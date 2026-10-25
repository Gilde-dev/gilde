import type { Feature } from '../feature/feature.entity.js';
import type { Job } from '../job/job.entity.js';
import type { Repo } from '../repo/repo.entity.js';
import type { DownstreamJob } from './downstream.js';
import type { JobPayload } from './execution.port.js';

/** Longest feature spec handed to an agent, in characters. */
const FEATURE_SPEC_LIMIT = 8000;

export function buildJobPayload(job: Job, repo: Repo, feature: Feature | null, runId: string, attempt: number, downstream: DownstreamJob[] = []): JobPayload {
    return {
        gilde: 1,
        jobId: job.id,
        runId,
        attempt,
        repo: repo.fullName,
        baseBranch: repo.defaultBranch,
        title: job.title,
        task: job.task,
        acceptanceCriteria: job.acceptanceCriteria,
        testCommands: repo.testCommands,
        stacks: repo.stacks,
        ...(feature
            ? { feature: { title: feature.title, spec: feature.spec.slice(0, FEATURE_SPEC_LIMIT), acceptanceCriteria: feature.acceptanceCriteria } }
            : {}),
        ...(downstream.length ? { downstream } : {}),
        ...(job.prNumber !== null && job.branch
            ? {
                continueOn: {
                    branch: job.branch,
                    prNumber: job.prNumber,
                    reason: job.lastReason ?? 'Continue the work on this PR.',
                },
            }
            : {}),
    };
}
