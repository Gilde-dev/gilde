import { In, type EntityManager } from 'typeorm';

import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';

/** Most downstream jobs handed to an agent. */
export const DOWNSTREAM_LIMIT = 20;
/** Longest downstream task handed to an agent, in characters. */
const DOWNSTREAM_TASK_LIMIT = 4000;

export interface DownstreamJob {
    jobId: string;
    title: string;
    task: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
}

/**
 * Jobs in triage or queued that an agent could propose changes for: those that depend on this job directly or
 * transitively, plus the unstarted jobs of the same feature. Oldest first.
 */
export async function loadDownstream(manager: EntityManager, job: Job): Promise<DownstreamJob[]> {
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

    const candidates = await manager.find(Job, {
        where: [
            ...(ids.size ? [{ id: In([...ids]), status: In(['triage', 'queued']) }] : []),
            ...(job.featureId ? [{ featureId: job.featureId, status: In(['triage', 'queued']) }] : []),
        ],
        order: { createdAt: 'ASC' },
    });
    const downstream = candidates.filter((j) => j.id !== job.id).slice(0, DOWNSTREAM_LIMIT);
    if (!downstream.length) return [];

    const links = await manager.find(JobDependency, { where: { jobId: In(downstream.map((j) => j.id)) } });
    return downstream.map((j) => ({
        jobId: j.id,
        title: j.title,
        task: j.task.slice(0, DOWNSTREAM_TASK_LIMIT),
        acceptanceCriteria: j.acceptanceCriteria,
        dependsOn: links.filter((l) => l.jobId === j.id).map((l) => l.dependsOnJobId),
    }));
}
