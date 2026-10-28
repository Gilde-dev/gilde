import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { FEATURE_CLOSED } from '../feature/feature-state.js';
import { FeedbackService } from '../feedback/feedback.service.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { LESSON_JOB_HOOK, type LessonJobHook } from '../lesson/lesson-hook.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { RepoService } from '../repo/repo.service.js';
import { RunService } from '../run/run.service.js';
import { emptyAgentTotals } from '../usage/agent-usage.service.js';
import { AgentUsageService } from '../usage/agent-usage.service.js';
import type { BlockingJobDto, CreateJobDto, EnqueueResponseDto, UpdateJobDto, JobDetailResponseDto, JobResponseDto, ListJobsQuery } from './job.dto.js';
import { JobDependency } from './job-dependency.entity.js';
import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { JOB_STATUSES, TERMINAL, nextStatus, type JobEvent, type JobStatus } from './job-state.js';
import { taskContentProblem } from './task-size.js';
import { JobRevision } from '../revision/revision.entity.js';
import { User } from '../user/user.entity.js';

export interface StatusSnapshot {
    counts: Record<JobStatus, number>;
    parkedIds: string[];
    /** Merged jobs whose latest run reported blocked: exact count and the oldest ids (bounded). */
    mergedWithoutWork: { count: number; ids: string[] };
}

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
        @Optional() private readonly capture?: NotificationCaptureService,
        @Optional() private readonly agentUsage?: AgentUsageService,
    ) { }

    /**
     * `actor` is the user creating the job; null for system-created jobs. `manager` runs the writes (and the read-back) in
     * the caller's transaction, so a caller can commit the job together with its own records; without it nothing changes.
     */
    async create(repoId: string, dto: CreateJobDto, actor: { id: string } | null = null, manager?: EntityManager): Promise<JobResponseDto> {
        const jobs = manager?.getRepository(Job) ?? this.jobRepository;
        const dependencies = manager?.getRepository(JobDependency) ?? this.dependencyRepository;
        const repo = await this.repoService.getById(repoId); // 404 if unknown
        this.assertTaskContent(dto.task, dto.acceptanceCriteria ?? []);
        const dependsOn = dto.dependsOn ?? [];
        await this.validateDependencies(null, repo.projectId, dependsOn);
        const feature = dto.featureId ? await this.linkableFeature(dto.featureId, repo.projectId) : null;
        if (feature?.status === 'draft' && dto.status === 'queued') {
            throw new ConflictException('A draft feature cannot have queued jobs; create the job in triage or start the feature');
        }
        const { dependsOn: _ignored, status: _status, ...fields } = dto;
        const status = dto.status ?? (feature?.status === 'draft' ? 'triage' : 'queued');
        const entity = await jobs.save(
            jobs.create({
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
        await dependencies.insert(dependsOn.map((dependsOnJobId) => ({ jobId: entity.id, dependsOnJobId })));
        return (await this.toDTOs([entity], manager))[0];
    }

    /** Ids of the non-terminal jobs of a project whose title equals `title` (case-insensitive, trimmed). Counts all of them, not a capped list. */
    async findOpenByTitle(projectId: string, title: string, manager?: EntityManager): Promise<string[]> {
        const rows = await (manager?.getRepository(Job) ?? this.jobRepository).createQueryBuilder('job')
            .select('job.id', 'id')
            .where('job.projectId = :projectId', { projectId })
            .andWhere('job.status NOT IN (:...terminal)', { terminal: [...TERMINAL] })
            .andWhere('LOWER(TRIM(job.title)) = :title', { title: title.trim().toLowerCase() })
            .orderBy('job.createdAt', 'ASC')
            .getRawMany<{ id: string }>();
        return rows.map((r) => r.id);
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
        // Only a change to the task or criteria is checked, so legacy oversized jobs keep their metadata edits.
        if (content.task !== undefined || content.acceptanceCriteria !== undefined) {
            this.assertTaskContent(content.task ?? job.task, content.acceptanceCriteria ?? job.acceptanceCriteria);
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
        if (featureId !== undefined && featureId !== job.featureId) {
            // Leaving a feature can make the rest of it ready; joining one can't, but the check is cheap and exact.
            await this.capture?.featureReadiness(job.featureId);
            await this.capture?.featureReadiness(changes.featureId);
        }
        return this.getById(id);
    }

    /** 400 when the task and criteria together are over TASK_CONTENT_LIMIT. Runs before any write. */
    private assertTaskContent(task: string, acceptanceCriteria: string[]): void {
        const problem = taskContentProblem(task, acceptanceCriteria);
        if (problem) throw new BadRequestException(problem);
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
    private async toDTOs(entities: Job[], manager?: EntityManager): Promise<JobResponseDto[]> {
        if (!entities.length) return [];
        const jobRepository = manager?.getRepository(Job) ?? this.jobRepository;
        const m = manager ?? this.jobRepository.manager;
        const links = await (manager?.getRepository(JobDependency) ?? this.dependencyRepository).find({ where: { jobId: In(entities.map((e) => e.id)) } });
        const depIds = [...new Set(links.map((l) => l.dependsOnJobId))];
        const deps = depIds.length
            ? await jobRepository.find({ where: { id: In(depIds) }, select: { id: true, title: true, status: true, mergedBlocked: true } })
            : [];
        const depById = new Map(deps.map((d) => [d.id, d]));
        const revisions = await m.getRepository(JobRevision).find({
            where: { jobId: In(entities.map((e) => e.id)), status: In(['proposed', 'accepted']) },
            select: { jobId: true, status: true, revision: true },
        });
        const replacements = await jobRepository.find({
            where: { recreatedFromId: In(entities.map((e) => e.id)) },
            select: { id: true, recreatedFromId: true },
        });
        const replacedBy = new Map(replacements.map((r) => [r.recreatedFromId, r.id]));
        const creatorIds = [...new Set(entities.map((e) => e.createdById).filter((i): i is string => !!i))];
        const creators = creatorIds.length
            ? await m.getRepository(User).find({ where: { id: In(creatorIds) }, select: { id: true, name: true } })
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
                .filter((d): d is Job => !!d && (d.status !== 'merged' || d.mergedBlocked))
                .map((d) => ({ id: d.id, title: d.title, status: d.status, mergedBlocked: d.status === 'merged' && d.mergedBlocked }));
            return this.jobMapper.toDTO(e, { dependsOn: ids, blockedBy, ...revision, replacedById: replacedBy.get(e.id) ?? null, createdBy: e.createdById ? creatorById.get(e.createdById) ?? null : null });
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

    /**
     * Exact job counts per status for a whole project, and up to `parkedLimit` parked job ids (oldest first; the parked count is exact).
     * Aggregated in the database, so it is not limited like the public list.
     */
    async statusSnapshot(projectId: string, parkedLimit = 20): Promise<StatusSnapshot> {
        const rows = await this.jobRepository.createQueryBuilder('job')
            .select('job.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where('job.projectId = :projectId', { projectId })
            .groupBy('job.status')
            .getRawMany<{ status: JobStatus; count: string | number }>();
        const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
        for (const r of rows) counts[r.status] = Number(r.count);
        const parked = await this.jobRepository.find({ where: { projectId, status: 'parked' }, select: { id: true }, order: { createdAt: 'ASC', id: 'ASC' }, take: parkedLimit });
        // Merged without work: merged on GitHub, latest run blocked. The merged count above stays the factual GitHub state.
        const withoutWork = { projectId, status: 'merged' as const, mergedBlocked: true };
        const [mergedWithoutWorkCount, mergedWithoutWork] = await Promise.all([
            this.jobRepository.countBy(withoutWork),
            this.jobRepository.find({ where: withoutWork, select: { id: true }, order: { createdAt: 'ASC', id: 'ASC' }, take: parkedLimit }),
        ]);
        return {
            counts,
            parkedIds: parked.map((j) => j.id),
            mergedWithoutWork: { count: mergedWithoutWorkCount, ids: mergedWithoutWork.map((j) => j.id) },
        };
    }

    async getById(id: string): Promise<JobResponseDto> {
        return this.toDTO(await this.getOrFail(id));
    }

    async getDetail(id: string): Promise<JobDetailResponseDto> {
        const job = await this.getById(id);
        const runs = await this.runService.listForJob(id);
        // Two grouped queries for the whole detail, not one per run.
        const [perRun, perJob] = this.agentUsage
            ? await Promise.all([this.agentUsage.forRuns(runs.map((r) => r.id)), this.agentUsage.forJobs([id])])
            : [new Map(), new Map()];
        return {
            ...job,
            runs: runs.map((r) => ({ ...r, agentUsage: perRun.get(r.id) ?? emptyAgentTotals() })),
            agentUsage: perJob.get(id) ?? emptyAgentTotals(),
            feedback: await this.feedbackService.listForJob(id),
        };
    }

    async cancel(id: string): Promise<JobResponseDto> {
        const job = await this.apply(id, 'cancel');
        // Resolved lazily: LessonModule imports this module, so injecting it would be a cycle.
        await this.moduleRef?.get<LessonJobHook>(LESSON_JOB_HOOK, { strict: false })?.onJobEnded(id, 'cancelled');
        await this.capture?.featureReadiness(job.featureId);
        return job;
    }

    retry(id: string): Promise<JobResponseDto> {
        return this.apply(id, 'manual_retry', 'Requeued manually.');
    }

    /**
     * Recovery for a merged-without-work job: creates a fresh job in triage with the same content, feature and own
     * prerequisites, and points every dependency edge that targeted the original at the replacement. Creation and
     * rewiring commit together. `recreated_from_id` is unique, so concurrent or repeated requests end up with one
     * replacement: the loser gets the existing one. Nothing is enqueued, and the original and its history stay as they are.
     */
    async recreate(id: string, actor: { id: string } | null = null): Promise<JobResponseDto> {
        const source = await this.getOrFail(id);
        const existing = await this.jobRepository.findOneBy({ recreatedFromId: id });
        if (existing) return this.getById(existing.id);
        if (source.status !== 'merged' || !source.mergedBlocked) {
            throw new ConflictException('Only a job that was merged without work (blocked) can be recreated');
        }
        let created: Job;
        try {
            created = await this.jobRepository.manager.transaction(async (m) => {
                // Re-read inside the transaction: the source may have changed since the check above.
                const fresh = await m.findOneBy(Job, { id });
                if (!fresh || fresh.status !== 'merged' || !fresh.mergedBlocked) {
                    throw new ConflictException('The job changed in the meantime, try again');
                }
                const replacement = await m.save(m.create(Job, {
                    projectId: fresh.projectId,
                    repoId: fresh.repoId,
                    featureId: fresh.featureId,
                    title: fresh.title,
                    task: fresh.task,
                    acceptanceCriteria: [...fresh.acceptanceCriteria],
                    status: 'triage',
                    queuedAt: null,
                    createdById: actor?.id ?? null,
                    recreatedFromId: fresh.id,
                }));
                const own = await m.find(JobDependency, { where: { jobId: fresh.id } });
                if (own.length) await m.insert(JobDependency, own.map((e) => ({ jobId: replacement.id, dependsOnJobId: e.dependsOnJobId })));
                // Direct rewiring, not setDependencies: dependents may be in any status, and none of them is reset or started.
                await m.update(JobDependency, { dependsOnJobId: fresh.id }, { dependsOnJobId: replacement.id });
                return replacement;
            });
        } catch (e) {
            // A concurrent request may have committed first (the unique index rejects the second insert): answer with its replacement.
            const winner = await this.jobRepository.findOneBy({ recreatedFromId: id });
            if (winner) return this.getById(winner.id);
            if (isUniqueViolation(e)) throw new ConflictException('The job changed in the meantime, try again');
            throw e;
        }
        await this.capture?.featureReadiness(created.featureId);
        return this.getById(created.id);
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
