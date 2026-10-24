import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';
import type { CreateRunDto, RunResponseDto } from './run.dto.js';
import { JobRun } from './run.entity.js';
import { RunMapper } from './run.mapper.js';

@Injectable()
export class RunService {

    constructor(
        private readonly runMapper: RunMapper,
        @InjectRepository(JobRun) private readonly runRepository: Repository<JobRun>,
    ) { }

    async create(dto: CreateRunDto): Promise<RunResponseDto> {
        try {
            const entity = await this.runRepository.save(
                this.runRepository.create({
                    ...dto,
                    firedAt: dto.firedAt ? new Date(dto.firedAt) : null,
                    finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : null,
                }),
            );
            return this.runMapper.toDTO(entity);
        } catch (e) {
            if (isUniqueViolation(e)) {
                throw new ConflictException(`Job ${dto.jobId} already has a run for attempt ${dto.attempt}`);
            }
            throw e;
        }
    }

    /** Runs of a job, oldest attempt first. */
    async listForJob(jobId: string): Promise<RunResponseDto[]> {
        const entities = await this.runRepository.find({ where: { jobId }, order: { attempt: 'ASC' } });
        return entities.map((e) => this.runMapper.toDTO(e));
    }

}
