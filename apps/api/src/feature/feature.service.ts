import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Job } from '../job/job.entity.js';
import type { BlockingJobDto } from '../job/job.dto.js';
import { TERMINAL, type JobStatus } from '../job/job-state.js';
import { AgentUsageService, emptyAgentTotals } from '../usage/agent-usage.service.js';
import { JobService } from '../job/job.service.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import { ProjectService } from '../project/project.service.js';
import type {
    CreateFeatureDto,
    FeatureCancelResponseDto,
    FeatureDetailResponseDto,
    FeatureDoneResponseDto,
    FeatureResponseDto,
    FeatureStartResponseDto,
    ListFeaturesQuery,
    UpdateFeatureDto,
} from './feature.dto.js';
import { Feature } from './feature.entity.js';
import { FeatureMapper } from './feature.mapper.js';
import { buildProgress, type StatusGroup } from './feature-progress.js';
import { nextFeatureStatus, type FeatureEvent } from './feature-state.js';

@Injectable()
export class FeatureService {

    constructor(
        private readonly featureMapper: FeatureMapper,
        private readonly projectService: ProjectService,
        private readonly jobService: JobService,
        @InjectRepository(Feature) private readonly featureRepository: Repository<Feature>,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @Optional() private readonly capture?: NotificationCaptureService,
        @Optional() private readonly agentUsage?: AgentUsageService,
        @Optional() private readonly scout?: ScoutSignalPublisher,
    ) { }

    async create(projectId: string, dto: CreateFeatureDto): Promise<FeatureResponseDto> {
        await this.projectService.getById(projectId); // 404 if unknown
        const entity = await this.featureRepository.save(
            this.featureRepository.create({
                projectId,
                title: dto.title,
                spec: dto.spec ?? '',
                acceptanceCriteria: dto.acceptanceCriteria ?? [],
                startedAt: null,
                doneAt: null,
            }),
        );
        return this.toDTO(entity);
    }

    async list(projectId: string, q: ListFeaturesQuery): Promise<FeatureResponseDto[]> {
        await this.projectService.getById(projectId);
        const entities = await this.featureRepository.find({
            where: { projectId, ...(q.status ? { status: q.status } : {}) },
            order: { createdAt: 'DESC' },
        });
        return this.toDTOs(entities);
    }

    async getById(id: string): Promise<FeatureResponseDto> {
        return this.toDTO(await this.getOrFail(id));
    }

    async getDetail(id: string): Promise<FeatureDetailResponseDto> {
        const feature = await this.getById(id);
        const total = this.agentUsage ? (await this.agentUsage.forFeatures([id])).get(id) : undefined;
        return { ...feature, jobs: await this.jobService.listByFeature(id), agentUsage: total ?? emptyAgentTotals() };
    }

    /** Edits title, spec and criteria while the feature is draft or active. */
    async update(id: string, dto: UpdateFeatureDto): Promise<FeatureResponseDto> {
        const feature = await this.getOrFail(id);
        if (feature.status !== 'draft' && feature.status !== 'active') {
            throw new ConflictException(`Cannot edit a feature that is ${feature.status}`);
        }
        const result = await this.featureRepository.update({ id, status: feature.status }, dto);
        if (!result.affected) throw new ConflictException('Feature changed in the meantime, try again');
        return this.getById(id);
    }

    /** draft → active, and queues all its triage jobs in the same transaction. */
    async start(id: string): Promise<FeatureStartResponseDto> {
        const feature = await this.getOrFail(id);
        const to = this.transitionTarget(feature, 'start');
        let enqueued: string[] = [];
        await this.featureRepository.manager.transaction(async (m) => {
            const result = await m.update(Feature, { id, status: feature.status }, { status: to, startedAt: new Date() });
            if (!result.affected) throw new ConflictException('Feature changed in the meantime, try again');
            const triage = await m.find(Job, { where: { featureId: id, status: 'triage' }, select: { id: true } });
            enqueued = triage.map((j) => j.id);
            if (enqueued.length) await this.jobService.enqueueManyIn(m, enqueued);
        });
        await this.capture?.featureReadiness(id);
        const warnings = enqueued.length ? (await this.jobService.loadEnqueued(enqueued)).flatMap((j) => j.warnings) : [];
        const seen = new Set<string>();
        return {
            ...(await this.getById(id)),
            warnings: warnings.filter((w) => {
                const key = `${w.dependencyId}:${w.message}`;
                return seen.has(key) ? false : (seen.add(key), true);
            }),
        };
    }

    /** active → done. Allowed while jobs are open; those are listed in the response. */
    async done(id: string): Promise<FeatureDoneResponseDto> {
        const doneAt = new Date();
        const feature = await this.transition(id, 'done', { doneAt });
        // A successful active -> done only (not readiness, not cancel); a later reopen and done is a new occurrence.
        await this.scout?.publish(feature.projectId, { type: 'feature_done', featureId: id, doneAt: doneAt.toISOString() });
        return { ...(await this.getById(id)), openJobs: await this.openJobs(id) };
    }

    /** Cancels the triage and queued jobs; jobs that are already running are left alone and listed. */
    async cancel(id: string): Promise<FeatureCancelResponseDto> {
        await this.transition(id, 'cancel');
        const jobs = await this.jobRepository.find({
            where: { featureId: id, status: In<JobStatus>(['triage', 'queued']) },
            select: { id: true, title: true },
        });
        const cancelledJobs: BlockingJobDto[] = [];
        for (const job of jobs) {
            try {
                await this.jobService.cancel(job.id);
                cancelledJobs.push({ id: job.id, title: job.title, status: 'cancelled' });
            } catch (e) {
                // The job started or ended since we looked; it is reported below with its real status.
                if (!(e instanceof ConflictException)) throw e;
            }
        }
        return { ...(await this.getById(id)), cancelledJobs, activeJobs: await this.openJobs(id) };
    }

    /** done → active. */
    async reopen(id: string): Promise<FeatureResponseDto> {
        await this.transition(id, 'reopen', { doneAt: null });
        await this.capture?.featureReadiness(id);
        return this.getById(id);
    }

    private async transition(id: string, event: FeatureEvent, changes: Partial<Feature> = {}): Promise<Feature> {
        const feature = await this.getOrFail(id);
        const to = this.transitionTarget(feature, event);
        const result = await this.featureRepository.update({ id, status: feature.status }, { ...changes, status: to });
        if (!result.affected) throw new ConflictException('Feature changed in the meantime, try again');
        return feature;
    }

    private transitionTarget(feature: Feature, event: FeatureEvent) {
        const to = nextFeatureStatus(feature.status, event);
        if (!to) throw new ConflictException(`Cannot ${event} a feature that is ${feature.status}`);
        return to;
    }

    /** Jobs of the feature that haven't finished (merged, rejected or cancelled). */
    private async openJobs(featureId: string): Promise<BlockingJobDto[]> {
        const jobs = await this.jobRepository.find({
            where: { featureId },
            select: { id: true, title: true, status: true },
            order: { createdAt: 'ASC' },
        });
        return jobs.filter((j) => !TERMINAL.has(j.status)).map((j) => ({ id: j.id, title: j.title, status: j.status }));
    }

    private async toDTO(e: Feature): Promise<FeatureResponseDto> {
        return (await this.toDTOs([e]))[0];
    }

    /** Progress for all features comes from one grouped query, whatever the number of features. */
    private async toDTOs(entities: Feature[]): Promise<FeatureResponseDto[]> {
        if (!entities.length) return [];
        const rows = await this.jobRepository.createQueryBuilder('job')
            .select('job.featureId', 'featureId')
            .addSelect('job.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .addSelect('SUM(job.attempts)', 'attempts')
            .where('job.featureId IN (:...ids)', { ids: entities.map((e) => e.id) })
            .groupBy('job.featureId')
            .addGroupBy('job.status')
            .getRawMany<{ featureId: string; status: JobStatus; count: string | number; attempts: string | number | null }>();
        const byFeature = new Map<string, StatusGroup[]>();
        for (const r of rows) {
            const group: StatusGroup = { status: r.status, count: Number(r.count), attempts: Number(r.attempts ?? 0) };
            byFeature.set(r.featureId, [...(byFeature.get(r.featureId) ?? []), group]);
        }
        const now = new Date();
        return entities.map((e) => this.featureMapper.toDTO(e, buildProgress(e, byFeature.get(e.id) ?? [], now)));
    }

    private async getOrFail(id: string): Promise<Feature> {
        const entity = await this.featureRepository.findOneBy({ id });
        if (!entity) throw new NotFoundException(`Feature ${id} not found`);
        return entity;
    }

}
