import { In, type EntityManager } from 'typeorm';

import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';

/** Most downstream jobs handed to an agent. */
export const DOWNSTREAM_LIMIT = 20;
/** Longest downstream task handed to an agent, in characters. */
export const DOWNSTREAM_TASK_LIMIT = 4000;

export interface DownstreamJob {
    jobId: string;
    title: string;
    task: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
}

/** The downstream jobs plus what trimming needs to know and the agent must not see. */
export interface DownstreamContext {
    /** At most DOWNSTREAM_LIMIT jobs, oldest first (created, then id). */
    jobs: DownstreamJob[];
    /** Ids among `jobs` that depend on the job directly or transitively; the rest are unrelated feature siblings. */
    dependents: ReadonlySet<string>;
    /** Candidates left out by the DOWNSTREAM_LIMIT cutoff. */
    omitted: number;
    /** True when a task was cut to DOWNSTREAM_TASK_LIMIT. */
    taskCapped: boolean;
}

const NO_DOWNSTREAM: DownstreamContext = { jobs: [], dependents: new Set(), omitted: 0, taskCapped: false };

/**
 * Jobs in triage or queued that an agent could propose changes for: those that depend on this job directly or
 * transitively, plus the unstarted jobs of the same feature. Oldest first.
 */
export async function loadDownstream(manager: EntityManager, job: Job): Promise<DownstreamJob[]> {
    return (await loadDownstreamContext(manager, job)).jobs;
}

/** `loadDownstream` with the dependent/sibling classification and the initial cutoffs that trimming needs. */
export async function loadDownstreamContext(manager: EntityManager, job: Job): Promise<DownstreamContext> {
    const ids = new Set<string>();
    let frontier = [job.id];
    const seen = new Set(frontier);
    while (frontier.length) {
        const links = await manager.find(JobDependency, { where: { dependsOnJobId: In(frontier) } });
        frontier = [...new Set(links.map((l) => l.jobId))].filter((id) => !seen.has(id));
        for (const id of frontier) {
            seen.add(id);
            ids.add(id);
        }
    }

    const where = [
        ...(ids.size ? [{ id: In([...ids]), status: In(['triage' as const, 'queued' as const]) }] : []),
        ...(job.featureId ? [{ featureId: job.featureId, status: In(['triage' as const, 'queued' as const]) }] : []),
    ];
    // TypeORM treats `where: []` as no filter at all, which returned the 20 oldest jobs of the whole database
    // (any status) for a job without dependents and without a feature.
    if (!where.length) return NO_DOWNSTREAM;
    const candidates = await manager.find(Job, { where, order: { createdAt: 'ASC', id: 'ASC' } });
    const eligible = candidates.filter((j) => j.id !== job.id);
    const downstream = eligible.slice(0, DOWNSTREAM_LIMIT);
    if (!downstream.length) return NO_DOWNSTREAM;

    const links = await manager.find(JobDependency, { where: { jobId: In(downstream.map((j) => j.id)) } });
    return {
        jobs: downstream.map((j) => ({
            jobId: j.id,
            title: j.title,
            task: j.task.slice(0, DOWNSTREAM_TASK_LIMIT),
            acceptanceCriteria: j.acceptanceCriteria,
            dependsOn: links.filter((l) => l.jobId === j.id).map((l) => l.dependsOnJobId),
        })),
        dependents: new Set(downstream.filter((j) => ids.has(j.id)).map((j) => j.id)),
        omitted: eligible.length - downstream.length,
        taskCapped: downstream.some((j) => j.task.length > DOWNSTREAM_TASK_LIMIT),
    };
}
