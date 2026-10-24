import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { FindOptionsWhere, In, Repository } from 'typeorm';

import { FeedbackService } from '../feedback/feedback.service.js';
import { LESSON_JOB_HOOK, type LessonJobHook } from '../lesson/lesson-hook.js';
import { RepoService } from '../repo/repo.service.js';
import { RunService } from '../run/run.service.js';
import type { BlockingJobDto, CreateJobDto, JobDetailResponseDto, JobResponseDto, ListJobsQuery } from './job.dto.js';
import { JobDependency } from './job-dependency.entity.js';
import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { nextStatus, type JobEvent } from './job-state.js';

@Injectable()
export class JobService {

    constructor(
        private readonly jobMapper: JobMapper,
        private readonly repoService: RepoService,
        private readonly runService: RunService,
        private readonly feedbackService: FeedbackService,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @InjectRepository(JobDependency) private readonly dependencyRepository: Repository<JobDependency>,
        private readonly moduleRef?: ModuleRef,
    ) { }

    async create(repoId: string, dto: CreateJobDto): Promise<JobResponseDto> {
        const repo = await this.repoService.getById(repoId); // 404 if unknown
        const dependsOn = dto.dependsOn ?? [];
        await this.validateDependencies(null, repo.projectId, dependsOn);
        const { dependsOn: _ignored, ...fields } = dto;
        const entity = await this.jobRepository.save(
            this.jobRepository.create({
                ...fields,
                acceptanceCriteria: dto.acceptanceCriteria ?? [],
                repoId,
                projectId: repo.projectId,
                status: 'queued',
                queuedAt: new Date(),
            }),
        );
        await this.dependencyRepository.insert(dependsOn.map((dependsOnJobId) => ({ jobId: entity.id, dependsOnJobId })));
        return this.toDTO(entity);
    }

    /** Replaces the dependency list of a queued job. */
    async setDependencies(id: string, dependsOn: string[]): Promise<JobResponseDto> {
        const job = await this.getOrFail(id);
        if (job.status !== 'queued') throw new ConflictException(`Cannot edit dependencies of a job that is ${job.status}`);
        await this.validateDependencies(job, job.projectId, dependsOn);
        await this.dependencyRepository.manager.transaction(async (m) => {
            await m.delete(JobDependency, { jobId: id });
            if (dependsOn.length) await m.insert(JobDependency, dependsOn.map((dependsOnJobId) => ({ jobId: id, dependsOnJobId })));
        });
        return this.getById(id);
    }

    private async validateDependencies(job: Job | null, projectId: string, dependsOn: string[]): Promise<void> {
        if (new Set(dependsOn).size !== dependsOn.length) throw new BadRequestException('Duplicate dependencies');
        if (job && dependsOn.includes(job.id)) throw new BadRequestException('A job cannot depend on itself');
        if (!dependsOn.length) return;
        const found = await this.jobRepository.find({ where: { id: In(dependsOn) }, select: { id: true, projectId: true } });
        const byId = new Map(found.map((j) => [j.id, j]));
        for (const dep of dependsOn) {
            const j = byId.get(dep);
            if (!j) throw new BadRequestException(`Dependency ${dep} does not exist`);
            if (j.projectId !== projectId) throw new BadRequestException(`Dependency ${dep} is in another project`);
        }
        if (!job) return;

        // Cycle check: walk the graph with this job's edges replaced by the proposed ones.
        const edges = await this.dependencyRepository.find();
        const graph = new Map<string, string[]>();
        for (const e of edges) {
            if (e.jobId === job.id) continue;
            graph.set(e.jobId, [...(graph.get(e.jobId) ?? []), e.dependsOnJobId]);
        }
        graph.set(job.id, dependsOn);
        const path = findCycle(graph, job.id);
        if (path) throw new BadRequestException(`Dependency cycle: ${path.join(' -> ')}`);
    }

    private async toDTO(e: Job): Promise<JobResponseDto> {
        return (await this.toDTOs([e]))[0];
    }

    /** Loads dependencies for all jobs with two queries, whatever the number of jobs. */
    private async toDTOs(entities: Job[]): Promise<JobResponseDto[]> {
        if (!entities.length) return [];
        const links = await this.dependencyRepository.find({ where: { jobId: In(entities.map((e) => e.id)) } });
        const depIds = [...new Set(links.map((l) => l.dependsOnJobId))];
        const deps = depIds.length
            ? await this.jobRepository.find({ where: { id: In(depIds) }, select: { id: true, title: true, status: true } })
            : [];
        const depById = new Map(deps.map((d) => [d.id, d]));
        return entities.map((e) => {
            const ids = links.filter((l) => l.jobId === e.id).map((l) => l.dependsOnJobId);
            const blockedBy: BlockingJobDto[] = ids
                .map((id) => depById.get(id))
                .filter((d): d is Job => !!d && d.status !== 'merged')
                .map((d) => ({ id: d.id, title: d.title, status: d.status }));
            return this.jobMapper.toDTO(e, { dependsOn: ids, blockedBy });
        });
    }

    async list(q: ListJobsQuery): Promise<JobResponseDto[]> {
        const where: FindOptionsWhere<Job> = {};
        if (q.projectId) where.projectId = q.projectId;
        if (q.repoId) where.repoId = q.repoId;
        if (q.status) where.status = q.status;
        const entities = await this.jobRepository.find({ where, order: { createdAt: 'DESC' }, take: q.limit });
        return this.toDTOs(entities);
    }

    async getById(id: string): Promise<JobResponseDto> {
        return this.toDTO(await this.getOrFail(id));
    }

    async getDetail(id: string): Promise<JobDetailResponseDto> {
        const job = await this.getById(id);
        return {
            ...job,
            runs: await this.runService.listForJob(id),
            feedback: await this.feedbackService.listForJob(id),
        };
    }

    async cancel(id: string): Promise<JobResponseDto> {
        const job = await this.apply(id, 'cancel');
        // Resolved lazily: LessonModule imports this module, so injecting it would be a cycle.
        await this.moduleRef?.get<LessonJobHook>(LESSON_JOB_HOOK, { strict: false })?.onJobEnded(id, 'cancelled');
        return job;
    }

    retry(id: string): Promise<JobResponseDto> {
        return this.apply(id, 'manual_retry', 'Requeued manually.');
    }

    private async apply(id: string, event: JobEvent, reason?: string): Promise<JobResponseDto> {
        const job = await this.getOrFail(id);
        const to = nextStatus(job.status, event);
        if (!to) throw new ConflictException(`Cannot ${event.replace('_', ' ')} a job that is ${job.status}`);

        const changes: Partial<Job> = { status: to };
        if (to === 'queued') changes.queuedAt = new Date();
        if (reason) changes.lastReason = reason;

        const result = await this.jobRepository.update({ id, status: job.status }, changes);
        if (!result.affected) throw new ConflictException('Job changed in the meantime, try again');

        return this.getById(id);
    }

    private async getOrFail(id: string): Promise<Job> {
        const entity = await this.jobRepository.findOneBy({ id });
        if (!entity) throw new NotFoundException(`Job ${id} not found`);
        return entity;
    }

}

/** Depth-first search from `start`; returns the cycle path (start ... back to a node on the stack) or null. */
function findCycle(graph: Map<string, string[]>, start: string): string[] | null {
    const stack: string[] = [];
    const done = new Set<string>();
    const visit = (node: string): string[] | null => {
        const at = stack.indexOf(node);
        if (at >= 0) return [...stack.slice(at), node];
        if (done.has(node)) return null;
        stack.push(node);
        for (const next of graph.get(node) ?? []) {
            const hit = visit(next);
            if (hit) return hit;
        }
        stack.pop();
        done.add(node);
        return null;
    };
    return visit(start);
}
