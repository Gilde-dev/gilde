import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { FEATURE_CLOSED } from '../feature/feature-state.js';
import { FeedbackService } from '../feedback/feedback.service.js';
import { LESSON_JOB_HOOK, type LessonJobHook } from '../lesson/lesson-hook.js';
import { RepoService } from '../repo/repo.service.js';
import { RunService } from '../run/run.service.js';
import type { BlockingJobDto, CreateJobDto, EnqueueResponseDto, UpdateJobDto, JobDetailResponseDto, JobResponseDto, ListJobsQuery } from './job.dto.js';
import { JobDependency } from './job-dependency.entity.js';
import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { nextStatus, type JobEvent } from './job-state.js';
import { JobRevision } from '../revision/revision.entity.js';
import { User } from '../user/user.entity.js';

@Injectable()
export class JobService {

    constructor(
        private readonly jobMapper: JobMapper,
        private readonly repoService: RepoService,
        private readonly runService: RunService,
        private readonly feedbackService: FeedbackService,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @InjectRepository(JobDependency) private readonly dependencyRepository: Repository<JobDependency>,
        @InjectRepository(Feature) private readonly featureRepository: Repository<Feature>,
        private readonly moduleRef?: ModuleRef,
    ) { }

    /** `actor` is the user creating the job; null for system-created jobs. */
    async create(repoId: string, dto: CreateJobDto, actor: { id: string } | null = null): Promise<JobResponseDto> {
        const repo = await this.repoService.getById(repoId); // 404 if unknown
        const dependsOn = dto.dependsOn ?? [];
        await this.validateDependencies(null, repo.projectId, dependsOn);
        const feature = dto.featureId ? await this.linkableFeature(dto.featureId, repo.projectId) : null;
        if (feature?.status === 'draft' && dto.status === 'queued') {
            throw new ConflictException('A draft feature cannot have queued jobs; create the job in triage or start the feature');
        }
        const { dependsOn: _ignored, status: _status, ...fields } = dto;
        const status = dto.status ?? (feature?.status === 'draft' ? 'triage' : 'queued');
        const entity = await this.jobRepository.save(
            this.jobRepository.create({
                ...fields,
                featureId: feature?.id ?? null,
                acceptanceCriteria: dto.acceptanceCriteria ?? [],
                repoId,
                createdById: actor?.id ?? null,
                projectId: repo.projectId,
                status,
                queuedAt: status === 'queued' ? new Date() : null,
            }),
        );
        await this.dependencyRepository.insert(dependsOn.map((dependsOnJobId) => ({ jobId: entity.id, dependsOnJobId })));
        return this.toDTO(entity);
    }

    /** Edits title, task and criteria while the job is in triage; the feature link also while it is queued. */
    async update(id: string, dto: UpdateJobDto): Promise<JobResponseDto> {
        const job = await this.getOrFail(id);
        const { featureId, ...content } = dto;
        if (Object.keys(content).length > 0 && job.status !== 'triage') {
            throw new ConflictException(`Cannot edit a job that is ${job.status}`);
        }
        if (featureId !== undefined && job.status !== 'triage' && job.status !== 'queued') {
            throw new ConflictException(`Cannot change the feature of a job that is ${job.status}`);
        }
        const changes: Partial<Job> = { ...content };
        if (featureId !== undefined) {
            if (featureId === null) {
                changes.featureId = null;
            } else {
                const feature = await this.linkableFeature(featureId, job.projectId);
                if (feature.status === 'draft' && job.status === 'queued') {
                    throw new ConflictException('A draft feature cannot have queued jobs; move the job to triage first');
                }
                changes.featureId = feature.id;
            }
        }
        const result = await this.jobRepository.update({ id, status: job.status }, changes);
        if (!result.affected) throw new ConflictException('Job changed in the meantime, try again');
        return this.getById(id);
    }

    /** The feature a job may be linked to: it must exist in the project (400) and still be open (409). */
    private async linkableFeature(featureId: string, projectId: string): Promise<Feature> {
        const feature = await this.featureRepository.findOneBy({ id: featureId });
        if (!feature) throw new BadRequestException(`Feature ${featureId} does not exist`);
        if (feature.projectId !== projectId) throw new BadRequestException(`Feature ${featureId} is in another project`);
        if (FEATURE_CLOSED.includes(feature.status)) throw new ConflictException(`Feature is ${feature.status}`);
        return feature;
    }

    async enqueue(id: string): Promise<EnqueueResponseDto> {
        return (await this.withWarnings([await this.apply(id, 'enqueue')]))[0];
    }

    toTriage(id: string): Promise<JobResponseDto> {
        return this.apply(id, 'triage');
    }

    /** All-or-nothing: if any job is missing or not in triage nothing is queued. */
    async enqueueMany(ids: string[]): Promise<EnqueueResponseDto[]> {
        await this.jobRepository.manager.transaction((m) => this.enqueueManyIn(m, ids));
        return this.loadEnqueued(ids);
    }

    /** The bulk enqueue inside a caller's transaction; pair with `loadEnqueued` once it committed. */
    async enqueueManyIn(m: EntityManager, ids: string[]): Promise<void> {
        const unique = [...new Set(ids)];
        const found = await m.find(Job, { where: { id: In(unique) } });
        const known = new Set(found.map((j) => j.id));
        const missing = unique.filter((i) => !known.has(i));
        if (missing.length) throw new NotFoundException({ message: `Jobs not found: ${missing.join(', ')}`, ids: missing });
        const offending = found.filter((j) => nextStatus(j.status, 'enqueue') === null).map((j) => j.id);
        if (offending.length) {
            throw new ConflictException({ message: `Jobs not in triage: ${offending.join(', ')}`, ids: offending });
        }
        const result = await m.update(Job, { id: In(unique), status: 'triage' }, { status: 'queued', queuedAt: new Date() });
        if (result.affected !== unique.length) throw new ConflictException('A job changed in the meantime, try again');
    }

    /** The jobs with their enqueue warnings. */
    async loadEnqueued(ids: string[]): Promise<EnqueueResponseDto[]> {
        const entities = await this.jobRepository.find({ where: { id: In([...new Set(ids)]) } });
        return this.withWarnings(await this.toDTOs(entities));
    }

    /** All jobs of a feature, oldest first. */
    async listByFeature(featureId: string): Promise<JobResponseDto[]> {
        return this.toDTOs(await this.jobRepository.find({ where: { featureId }, order: { createdAt: 'ASC' } }));
    }

    /** Adds a warning per dependency that is still in triage, so it can never be merged without a human. */
    private async withWarnings(jobs: JobResponseDto[]): Promise<EnqueueResponseDto[]> {
        return jobs.map((j) => ({
            ...j,
            warnings: j.blockedBy
                .filter((b) => b.status === 'triage')
                .map((b) => ({ dependencyId: b.id, message: `Depends on "${b.title}", which is still in triage` })),
        }));
    }

    /** Replaces the dependency list of a triage or queued job. */
    async setDependencies(id: string, dependsOn: string[]): Promise<JobResponseDto> {
        const job = await this.getOrFail(id);
        if (job.status !== 'queued' && job.status !== 'triage') throw new ConflictException(`Cannot edit dependencies of a job that is ${job.status}`);
        await this.validateDependencies(job, job.projectId, dependsOn);
        await this.dependencyRepository.manager.transaction(async (m) => {
            await m.delete(JobDependency, { jobId: id });
            if (dependsOn.length) await m.insert(JobDependency, dependsOn.map((dependsOnJobId) => ({ jobId: id, dependsOnJobId })));
        });
        return this.getById(id);
    }

    async validateDependencies(job: Job | null, projectId: string, dependsOn: string[]): Promise<void> {
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
        const revisions = await this.jobRepository.manager.getRepository(JobRevision).find({
            where: { jobId: In(entities.map((e) => e.id)), status: In(['proposed', 'accepted']) },
            select: { jobId: true, status: true, revision: true },
        });
        const creatorIds = [...new Set(entities.map((e) => e.createdById).filter((i): i is string => !!i))];
        const creators = creatorIds.length
            ? await this.jobRepository.manager.getRepository(User).find({ where: { id: In(creatorIds) }, select: { id: true, name: true } })
            : [];
        const creatorById = new Map(creators.map((u) => [u.id, { id: u.id, name: u.name }]));
        return entities.map((e) => {
            const own = revisions.filter((r) => r.jobId === e.id);
            const revision = {
                pendingRevisions: own.filter((r) => r.status === 'proposed').length,
                revision: Math.max(0, ...own.map((r) => r.revision ?? 0)),
            };
            const ids = links.filter((l) => l.jobId === e.id).map((l) => l.dependsOnJobId);
            const blockedBy: BlockingJobDto[] = ids
                .map((id) => depById.get(id))
                .filter((d): d is Job => !!d && d.status !== 'merged')
                .map((d) => ({ id: d.id, title: d.title, status: d.status }));
            return this.jobMapper.toDTO(e, { dependsOn: ids, blockedBy, ...revision, createdBy: e.createdById ? creatorById.get(e.createdById) ?? null : null });
        });
    }

    async list(q: ListJobsQuery, actor: { id: string } | null = null): Promise<JobResponseDto[]> {
        const where: FindOptionsWhere<Job> = {};
        if (q.projectId) where.projectId = q.projectId;
        if (q.repoId) where.repoId = q.repoId;
        if (q.featureId) where.featureId = q.featureId;
        if (q.status) where.status = q.status;
        if (q.createdBy) {
            const creatorId = q.createdBy === 'me' ? actor?.id : q.createdBy;
            if (!creatorId) return []; // "me" without a logged-in user matches nothing
            where.createdById = creatorId;
        }
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
        if (to === 'triage') changes.queuedAt = null;
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
