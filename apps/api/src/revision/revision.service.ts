import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { JobDependency } from '../job/job-dependency.entity.js';
import { nextStatus, type JobEvent } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { JobService } from '../job/job.service.js';
import { JobRun } from '../run/run.entity.js';
import type { ListRevisionsQuery, RevisionResponseDto } from './revision.dto.js';
import { JobRevision } from './revision.entity.js';

@Injectable()
export class RevisionService {

    constructor(
        private readonly jobService: JobService,
        @InjectRepository(JobRevision) private readonly revisions: Repository<JobRevision>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @InjectRepository(JobDependency) private readonly dependencies: Repository<JobDependency>,
    ) { }

    async listForJob(jobId: string): Promise<RevisionResponseDto[]> {
        if (!await this.jobs.existsBy({ id: jobId })) throw new NotFoundException(`Job ${jobId} not found`);
        return this.toDTOs(await this.revisions.find({ where: { jobId }, order: { createdAt: 'DESC' } }));
    }

    async list(q: ListRevisionsQuery): Promise<RevisionResponseDto[]> {
        const qb = this.revisions.createQueryBuilder('r')
            .innerJoin(Job, 'j', 'j.id = r.jobId')
            .orderBy('r.createdAt', 'DESC');
        if (q.status) qb.andWhere('r.status = :status', { status: q.status });
        if (q.projectId) qb.andWhere('j.projectId = :projectId', { projectId: q.projectId });
        return this.toDTOs(await qb.getMany());
    }

    /**
     * Applies the non-null fields to the job and rejects the job's other proposals. Allowed while the job has not
     * started; the exception is a revision the job's own blocked run proposed, which also requeues a parked or
     * awaiting-review job.
     */
    async accept(id: string): Promise<RevisionResponseDto> {
        const rev = await this.getProposed(id);
        const job = await this.jobs.findOneByOrFail({ id: rev.jobId });
        const requeue = await this.requeueEvent(rev, job);
        if (!requeue && job.status !== 'triage' && job.status !== 'queued') {
            throw new ConflictException(`Cannot revise a job that is ${job.status}`);
        }
        if (rev.dependsOn) await this.jobService.validateDependencies(job, job.projectId, rev.dependsOn);

        const decidedAt = new Date();
        await this.revisions.manager.transaction(async (m) => {
            const last = await m.findOne(JobRevision, { where: { jobId: job.id, status: 'accepted' }, order: { revision: 'DESC' } });
            const number = (last?.revision ?? 0) + 1;
            const changes: Partial<Job> = {};
            if (rev.title !== null) changes.title = rev.title;
            if (rev.task !== null) changes.task = rev.task;
            if (rev.acceptanceCriteria !== null) changes.acceptanceCriteria = rev.acceptanceCriteria;
            if (requeue) {
                changes.status = nextStatus(job.status, requeue)!;
                changes.queuedAt = decidedAt;
                changes.lastReason = `Task revised (revision ${number}): ${rev.reason}`;
            }
            if (Object.keys(changes).length) {
                const res = await m.update(Job, { id: job.id, status: job.status }, changes);
                if (!res.affected) throw new ConflictException('Job changed in the meantime, try again');
            }
            if (rev.dependsOn) {
                await m.delete(JobDependency, { jobId: job.id });
                if (rev.dependsOn.length) {
                    await m.insert(JobDependency, rev.dependsOn.map((dependsOnJobId) => ({ jobId: job.id, dependsOnJobId })));
                }
            }
            const claimed = await m.update(JobRevision, { id: rev.id, status: 'proposed' }, { status: 'accepted', revision: number, decidedAt });
            if (!claimed.affected) throw new ConflictException('Revision changed in the meantime, try again');
            await m.update(JobRevision, { jobId: job.id, status: 'proposed' }, { status: 'rejected', decidedAt });
        });
        return (await this.toDTOs([await this.revisions.findOneByOrFail({ id })]))[0];
    }

    async reject(id: string): Promise<RevisionResponseDto> {
        const rev = await this.getProposed(id);
        const res = await this.revisions.update({ id: rev.id, status: 'proposed' }, { status: 'rejected', decidedAt: new Date() });
        if (!res.affected) throw new ConflictException('Revision changed in the meantime, try again');
        return (await this.toDTOs([await this.revisions.findOneByOrFail({ id })]))[0];
    }

    private async getProposed(id: string): Promise<JobRevision> {
        const rev = await this.revisions.findOneBy({ id });
        if (!rev) throw new NotFoundException(`Revision ${id} not found`);
        if (rev.status !== 'proposed') throw new ConflictException(`Revision is already ${rev.status}`);
        return rev;
    }

    /** The event that requeues the job when it proposed this revision itself after a blocked outcome. */
    private async requeueEvent(rev: JobRevision, job: Job): Promise<JobEvent | null> {
        if (job.status !== 'parked' && job.status !== 'awaiting_review') return null;
        if (!rev.sourceRunId) return null;
        const run = await this.runs.findOneBy({ id: rev.sourceRunId });
        if (!run || run.jobId !== job.id || run.result?.outcome !== 'blocked') return null;
        return job.status === 'parked' ? 'manual_retry' : 'retry';
    }

    private async toDTOs(entities: JobRevision[]): Promise<RevisionResponseDto[]> {
        if (!entities.length) return [];
        const jobs = await this.jobs.find({ where: { id: In([...new Set(entities.map((e) => e.jobId))]) } });
        const jobById = new Map(jobs.map((j) => [j.id, j]));
        const links = await this.dependencies.find({ where: { jobId: In(jobs.map((j) => j.id)) } });
        const runIds = [...new Set(entities.map((e) => e.sourceRunId).filter((r): r is string => !!r))];
        const runs = runIds.length ? await this.runs.find({ where: { id: In(runIds) } }) : [];
        const runById = new Map(runs.map((r) => [r.id, r]));
        const prJobs = runs.length ? await this.jobs.find({ where: { id: In(runs.map((r) => r.jobId)) } }) : [];
        const prJobById = new Map(prJobs.map((j) => [j.id, j]));

        return entities.map((e) => {
            const job = jobById.get(e.jobId)!;
            const prJob = prJobById.get(runById.get(e.sourceRunId ?? '')?.jobId ?? '');
            return {
                id: e.id,
                jobId: e.jobId,
                revision: e.revision,
                title: e.title,
                task: e.task,
                acceptanceCriteria: e.acceptanceCriteria,
                dependsOn: e.dependsOn,
                reason: e.reason,
                sourceRunId: e.sourceRunId,
                status: e.status,
                decidedAt: e.decidedAt?.toISOString() ?? null,
                createdAt: e.createdAt.toISOString(),
                job: {
                    id: job.id,
                    title: job.title,
                    task: job.task,
                    acceptanceCriteria: job.acceptanceCriteria,
                    dependsOn: links.filter((l) => l.jobId === job.id).map((l) => l.dependsOnJobId),
                    status: job.status,
                },
                pr: prJob?.prNumber != null && prJob.prUrl ? { number: prJob.prNumber, url: prJob.prUrl } : null,
            };
        });
    }

}
