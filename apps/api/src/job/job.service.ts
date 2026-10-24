import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { RepoService } from '../repo/repo.service.js';
import { RunService } from '../run/run.service.js';
import type { CreateJobDto, JobDetailResponseDto, JobResponseDto, ListJobsQuery } from './job.dto.js';
import { Job } from './job.entity.js';
import { JobMapper } from './job.mapper.js';
import { nextStatus, type JobEvent } from './job-state.js';

@Injectable()
export class JobService {

    constructor(
        private readonly jobMapper: JobMapper,
        private readonly repoService: RepoService,
        private readonly runService: RunService,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
    ) { }

    async create(repoId: string, dto: CreateJobDto): Promise<JobResponseDto> {
        const repo = await this.repoService.getById(repoId); // 404 if unknown
        const entity = await this.jobRepository.save(
            this.jobRepository.create({
                ...dto,
                acceptanceCriteria: dto.acceptanceCriteria ?? [],
                repoId,
                projectId: repo.projectId,
                status: 'queued',
                queuedAt: new Date(),
            }),
        );
        return this.jobMapper.toDTO(entity);
    }

    async list(q: ListJobsQuery): Promise<JobResponseDto[]> {
        const where: FindOptionsWhere<Job> = {};
        if (q.projectId) where.projectId = q.projectId;
        if (q.repoId) where.repoId = q.repoId;
        if (q.status) where.status = q.status;
        const entities = await this.jobRepository.find({ where, order: { createdAt: 'DESC' }, take: q.limit });
        return entities.map((e) => this.jobMapper.toDTO(e));
    }

    async getById(id: string): Promise<JobResponseDto> {
        return this.jobMapper.toDTO(await this.getOrFail(id));
    }

    async getDetail(id: string): Promise<JobDetailResponseDto> {
        const job = await this.getById(id);
        return { ...job, runs: await this.runService.listForJob(id) };
    }

    cancel(id: string): Promise<JobResponseDto> {
        return this.apply(id, 'cancel');
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