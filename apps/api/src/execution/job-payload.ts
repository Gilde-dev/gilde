import type { Feature } from '../feature/feature.entity.js';
import type { Job } from '../job/job.entity.js';
import type { Repo } from '../repo/repo.entity.js';
import { DOWNSTREAM_TASK_LIMIT, type DownstreamContext, type DownstreamJob } from './downstream.js';
import type { JobLesson, JobPayload, PromptContext } from './execution.port.js';

/** Longest feature spec handed to an agent, in characters. */
export const FEATURE_SPEC_LIMIT = 8000;

export function buildJobPayload(job: Job, repo: Repo, feature: Feature | null, runId: string, attempt: number, downstream: DownstreamJob[] = [], lessons: JobLesson[] = []): JobPayload {
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
        ...(lessons.length ? { lessons } : {}),
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

/** The payload plus what the initial caps cut, for `prepare`: the context never reaches the agent. */
export function buildJobPromptInput(
    job: Job, repo: Repo, feature: Feature | null, runId: string, attempt: number, downstream: DownstreamContext, lessons: JobLesson[] = [],
): { payload: JobPayload; context: PromptContext } {
    return {
        payload: buildJobPayload(job, repo, feature, runId, attempt, downstream.jobs, lessons),
        context: {
            dependents: downstream.dependents,
            initial: {
                ...(downstream.taskCapped ? { downstreamTaskCap: DOWNSTREAM_TASK_LIMIT } : {}),
                ...(downstream.omitted ? { downstreamOmitted: downstream.omitted } : {}),
                ...(feature && feature.spec.length > FEATURE_SPEC_LIMIT ? { featureSpecCap: FEATURE_SPEC_LIMIT } : {}),
            },
        },
    };
}
